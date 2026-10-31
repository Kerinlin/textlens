/**
 * Native macOS selection bridge for TextLens.
 *
 * The Accessibility traversal, text-range bounds helpers, and input detection
 * in this file are adapted from selection-hook 2.0.2:
 *
 * Copyright (c) 2025 0xfullex (https://github.com/0xfullex/selection-hook)
 * Licensed under the MIT License. See LICENSE.selection-hook.
 *
 * This implementation exposes a small C ABI and intentionally contains no
 * Node/N-API integration.
 */

#import "selection_bridge.h"

#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdarg>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <new>
#include <limits>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;

constexpr double kMinimumDragDistance = 4.0;
constexpr uint64_t kMaximumDragDurationMs = 15'000;
constexpr uint64_t kDoubleClickDurationMs = 500;
constexpr double kDoubleClickDistance = 4.0;
constexpr size_t kMaximumQueuedTasks = 64;
// Bounds every AX round-trip to a single app so one slow/hung process can't
// stall the shared single-threaded capture worker for every other app.
constexpr float kAXMessagingTimeoutSeconds = 0.08f;
// Geometry is optional because the mouse-up point is always a placement
// fallback. Give range-bound queries a smaller budget so a correct text read
// is never held behind a slow PDF/Office layout calculation.
constexpr float kAXGeometryMessagingTimeoutSeconds = 0.03f;
// Selection capture stays below a perceptible delay even when a provider
// responds to individual AX requests but exposes a deep, sparse tree.
constexpr uint64_t kAXCaptureBudgetMs = 260;
constexpr uint64_t kDocumentAXCaptureBudgetMs = 300;
// WebKit/Chromium often fail or truncate AXSelectedText around one paragraph.
// Parameterized AXStringForRange still returns the real selection, so long
// reads are chunked instead of rejected. 16k stays inside one AX round-trip;
// the shared runtime cap remains 1_000_000 scalars.
constexpr CFIndex kAXStringForRangeChunkLength = 16'000;
constexpr CFIndex kAXSelectedTextMaximumLength = 1'000'000;
// Some editors publish only a bounded accessibility mirror. Monaco's unit is
// 500 characters; other hosts truncate around a paragraph. The copy command is
// the generic fallback, so it is not tied to an application id. Electron often
// needs longer than one AX round-trip to publish that copy.
constexpr uint64_t kClipboardCaptureBudgetMs = 450;
constexpr NSUInteger kAccessibilityMirrorBoundary = 500;
// WeChat's custom chat canvas may expose no AX selection. Keep its legacy
// clipboard fallback bounded and cancellable like the editor-specific path.
constexpr uint64_t kWeChatClipboardCaptureBudgetMs = 500;
constexpr NSUInteger kMaximumClipboardBackupBytes = 64 * 1024 * 1024;
constexpr int64_t kSyntheticCopyEventMarker = 0x544C434F5059; // "TLCOPY"
// The copy probe is a real key event. While it is in flight, the listen-only
// tap must not treat it as user input: keyDown otherwise cancels the capture
// waiting for the editor to publish the selection. The event-source field is
// not reliable across HID re-injection, so the in-flight count is the gate.
std::atomic<uint32_t> gSyntheticCopyPosts{0};

struct SyntheticCopyGuard {
    SyntheticCopyGuard() {
        gSyntheticCopyPosts.fetch_add(1, std::memory_order_acq_rel);
    }
    ~SyntheticCopyGuard() {
        gSyntheticCopyPosts.fetch_sub(1, std::memory_order_acq_rel);
    }
    SyntheticCopyGuard(const SyntheticCopyGuard &) = delete;
    SyntheticCopyGuard &operator=(const SyntheticCopyGuard &) = delete;
};
constexpr uint64_t kAXCompatibilityRetryDelayMs = 28;
constexpr uint64_t kAXLateSelectionRetryDelayMs = 24;
// Proactive self-healing check for the event tap, mirroring Windows' hook
// health-check cadence; the reactive re-enable in eventTapCallback only
// fires on the next incoming event, which never arrives if the tap was
// disabled during a quiet period.
constexpr CFTimeInterval kEventTapHealthCheckIntervalSeconds = 5.0;

enum class Trigger {
    Drag,
    DoubleClick,
    ShiftClick,
    Keyboard,
    Manual,
};

enum class SelectionMethod {
    Accessibility,
    Clipboard,
};

struct SelectionInfo {
    std::string text;
    std::string bundleId;
    std::string appName;
    // Kept private to the native bridge. Some AX providers report this value
    // as selected text when the actual range is unavailable.
    std::string windowTitle;
    SelectionMethod method = SelectionMethod::Accessibility;
    Trigger trigger = Trigger::Manual;
    bool fullscreen = false;

    bool hasBounds = false;
    CGRect bounds = CGRectZero;

    bool hasStartTop = false;
    bool hasStartBottom = false;
    bool hasEndTop = false;
    bool hasEndBottom = false;
    CGPoint startTop = CGPointZero;
    CGPoint startBottom = CGPointZero;
    CGPoint endTop = CGPointZero;
    CGPoint endBottom = CGPointZero;

    bool hasMouseStart = false;
    bool hasMouseEnd = false;
    CGPoint mouseStart = CGPointZero;
    CGPoint mouseEnd = CGPointZero;
    CGPoint mouseCurrent = CGPointZero;
    // UTF-16 length reported by AXSelectedTextRange. Zero when the provider
    // does not expose a range. Used only to detect a truncated mirror.
    CFIndex selectedRangeLength = 0;
};

enum class TaskKind {
    Capture,
    Dismiss,
};

struct Task {
    TaskKind kind = TaskKind::Dismiss;
    Trigger trigger = Trigger::Manual;
    std::string dismissReason;
    CGPoint mouseStart = CGPointZero;
    CGPoint mouseEnd = CGPointZero;
    CGPoint mouseCurrent = CGPointZero;
    bool hasMouseStart = false;
    bool hasMouseEnd = false;
    int64_t targetPid = 0;
    uint64_t generation = 0;
    uint64_t enqueuedAtMs = 0;
};

static uint64_t MonotonicMilliseconds() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        Clock::now().time_since_epoch()).count());
}

// Every AX request is tied to the originating input generation and a single
// wall-clock budget. AX providers can block independently even after their
// application element was configured with a messaging timeout, so checking at
// traversal boundaries is what keeps a stale PDF/Office read from delaying the
// next selection.
struct AccessibilityReadContext {
    const std::atomic<uint64_t> *generation = nullptr;
    uint64_t expectedGeneration = 0;
    uint64_t deadlineMs = 0;

    bool IsCurrent() const {
        return (generation == nullptr ||
                generation->load(std::memory_order_acquire) == expectedGeneration) &&
            MonotonicMilliseconds() < deadlineMs;
    }
};

static void ConfigureAccessibilityElement(AXUIElementRef element) {
    if (element != nullptr) {
        AXUIElementSetMessagingTimeout(element, kAXMessagingTimeoutSeconds);
    }
}

static bool SelectionTimingEnabled() {
    static const bool enabled = [] {
        const char *value = std::getenv("TEXTLENS_SELECTION_TRACE");
        return value != nullptr &&
            (std::strcmp(value, "1") == 0 || std::strcmp(value, "true") == 0 ||
             std::strcmp(value, "TRUE") == 0);
    }();
    return enabled;
}

static void TraceSelectionTiming(const char *stage, uint64_t durationMs) {
    if (SelectionTimingEnabled()) {
        std::fprintf(
            stderr,
            "[selection-timing] stage=%s duration_ms=%llu\n",
            stage,
            static_cast<unsigned long long>(durationMs));
    }
}

// Decision-level trace for the capture pipeline. Unlike the timing trace this
// also appends to a fixed file so a dev-server terminal that scrolled away or
// a detached launch does not lose the evidence.
static void TraceDecision(const char *format, ...) {
    if (!SelectionTimingEnabled()) {
        return;
    }
    char line[1024];
    va_list args;
    va_start(args, format);
    const int written = std::vsnprintf(line, sizeof(line), format, args);
    va_end(args);
    if (written <= 0) {
        return;
    }
    std::fprintf(stderr, "[selection-trace] %s\n", line);
    if (FILE *file = std::fopen("/tmp/textlens_selection_trace.log", "a")) {
        std::fprintf(file, "[selection-trace] %s\n", line);
        std::fclose(file);
    }
}

static uint64_t TimestampMilliseconds() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}

static std::string StringFromNSString(NSString *value) {
    if (value == nil) {
        return {};
    }
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
    if (data == nil) {
        return {};
    }
    return std::string(static_cast<const char *>(data.bytes), data.length);
}

static NSString *NSStringFromString(const std::string &value) {
    return [[NSString alloc] initWithBytes:value.data()
                                    length:value.size()
                                  encoding:NSUTF8StringEncoding];
}

static bool StringFromCFString(CFStringRef value, std::string &result) {
    if (value == nullptr) {
        return false;
    }
    CFIndex length = CFStringGetLength(value);
    if (length <= 0) {
        return false;
    }
    CFIndex maximum = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
    if (maximum <= 1) {
        return false;
    }
    std::vector<char> buffer(static_cast<size_t>(maximum));
    if (!CFStringGetCString(value, buffer.data(), maximum, kCFStringEncodingUTF8)) {
        return false;
    }
    result.assign(buffer.data());
    return !result.empty();
}

static bool IsBlank(const std::string &value) {
    NSString *string = NSStringFromString(value);
    if (string == nil) {
        return true;
    }
    return [[string stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] == 0;
}

static CGPoint CurrentMousePosition() {
    CGEventRef event = CGEventCreate(nullptr);
    if (event == nullptr) {
        return CGPointZero;
    }
    CGPoint point = CGEventGetLocation(event);
    CFRelease(event);
    return point;
}

static NSRunningApplication *FrontmostApplication() {
    return [NSWorkspace sharedWorkspace].frontmostApplication;
}

static bool IsExcludedApplication(
    NSRunningApplication *application,
    const std::string &excludedBundleId) {
    if (application == nil || application.processIdentifier == getpid()) {
        return true;
    }
    // A missing bundle id (some CLI-launched GUI processes, Wine/JVM-hosted
    // apps) no longer disqualifies an app outright; identity for matching
    // falls back to appName (localizedName) elsewhere in the pipeline.
    NSString *bundle = application.bundleIdentifier;
    if (bundle != nil && bundle.length > 0 && !excludedBundleId.empty() &&
        StringFromNSString(bundle) == excludedBundleId) {
        return true;
    }
    return false;
}

static bool IsReasonableRect(CGRect rect) {
    return std::isfinite(rect.origin.x) && std::isfinite(rect.origin.y) &&
        std::isfinite(rect.size.width) && std::isfinite(rect.size.height) &&
        rect.size.width > 0.0 && rect.size.height > 0.0 &&
        rect.size.width < 200'000.0 && rect.size.height < 200'000.0 &&
        std::abs(rect.origin.x) < 500'000.0 && std::abs(rect.origin.y) < 500'000.0;
}

static void StoreAggregateBounds(SelectionInfo &info, CGRect rect) {
    info.hasBounds = true;
    info.bounds = rect;
    info.hasStartTop = true;
    info.hasStartBottom = true;
    info.hasEndTop = true;
    info.hasEndBottom = true;
    info.startTop = CGPointMake(CGRectGetMinX(rect), CGRectGetMinY(rect));
    info.startBottom = CGPointMake(CGRectGetMinX(rect), CGRectGetMaxY(rect));
    info.endTop = CGPointMake(CGRectGetMaxX(rect), CGRectGetMinY(rect));
    info.endBottom = CGPointMake(CGRectGetMaxX(rect), CGRectGetMaxY(rect));
}

static bool ReadSelectionBounds(
    AXUIElementRef element,
    SelectionInfo &info,
    const AccessibilityReadContext &context) {
    if (element == nullptr || !context.IsCurrent()) {
        return false;
    }

    // The selection text is already validated at this point. Bounds only
    // improve placement, so cap this optional work much more aggressively
    // than the text read itself.
    AXUIElementSetMessagingTimeout(element, kAXGeometryMessagingTimeoutSeconds);

    AXValueRef selectedRangeValue = nullptr;
    AXError error = AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextRangeAttribute,
        reinterpret_cast<CFTypeRef *>(&selectedRangeValue));
    if (error != kAXErrorSuccess || selectedRangeValue == nullptr) {
        return false;
    }

    CFRange range = CFRangeMake(0, 0);
    bool hasRange = AXValueGetValue(selectedRangeValue, kAXValueTypeCFRange, &range) &&
        range.location >= 0 && range.length > 0 &&
        range.length <= std::numeric_limits<CFIndex>::max() - range.location;
    if (!hasRange) {
        CFRelease(selectedRangeValue);
        return false;
    }

    AXValueRef aggregateBoundsValue = nullptr;
    AXError aggregateError = context.IsCurrent()
        ? AXUIElementCopyParameterizedAttributeValue(
              element,
              kAXBoundsForRangeParameterizedAttribute,
              selectedRangeValue,
              reinterpret_cast<CFTypeRef *>(&aggregateBoundsValue))
        : kAXErrorFailure;
    CGRect aggregateRect = CGRectZero;
    if (aggregateError == kAXErrorSuccess && aggregateBoundsValue != nullptr &&
        AXValueGetValue(aggregateBoundsValue, kAXValueTypeCGRect, &aggregateRect) &&
        IsReasonableRect(aggregateRect)) {
        StoreAggregateBounds(info, aggregateRect);
    }
    if (aggregateBoundsValue != nullptr) CFRelease(aggregateBoundsValue);

    CFRelease(selectedRangeValue);
    return info.hasBounds;
}

static bool ReadStringForRange(
    AXUIElementRef element,
    CFRange range,
    std::string &text,
    const AccessibilityReadContext &context) {
    if (element == nullptr || !context.IsCurrent() || range.location < 0 || range.length <= 0) {
        return false;
    }
    AXValueRef rangeValue = AXValueCreate(kAXValueTypeCFRange, &range);
    if (rangeValue == nullptr) {
        return false;
    }
    CFTypeRef value = nullptr;
    AXError error = context.IsCurrent()
        ? AXUIElementCopyParameterizedAttributeValue(
              element,
              kAXStringForRangeParameterizedAttribute,
              rangeValue,
              &value)
        : kAXErrorFailure;
    CFRelease(rangeValue);
    if (error != kAXErrorSuccess || value == nullptr) {
        return false;
    }
    bool success = false;
    if (CFGetTypeID(value) == CFStringGetTypeID()) {
        success = StringFromCFString(static_cast<CFStringRef>(value), text) && !text.empty();
    }
    CFRelease(value);
    return success && context.IsCurrent();
}

// AXSelectedText is commonly empty or truncated once a selection passes about
// one paragraph. The selected range plus AXStringForRange still covers article
// length. Chunk so one parameterized call cannot stall the capture worker, and
// stop at the same scalar cap the runtime uses to hide the toolbar.
static bool ReadSelectedTextByRange(
    AXUIElementRef element,
    std::string &text,
    const AccessibilityReadContext &context) {
    if (element == nullptr || !context.IsCurrent()) {
        return false;
    }
    AXValueRef rangeValue = nullptr;
    AXError error = AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextRangeAttribute,
        reinterpret_cast<CFTypeRef *>(&rangeValue));
    if (error != kAXErrorSuccess || rangeValue == nullptr) {
        return false;
    }
    CFRange range = CFRangeMake(0, 0);
    bool hasRange = AXValueGetValue(rangeValue, kAXValueTypeCFRange, &range) &&
        range.location >= 0 && range.length > 0 &&
        range.length <= std::numeric_limits<CFIndex>::max() - range.location;
    CFRelease(rangeValue);
    if (!hasRange) {
        return false;
    }
    // Above the shared runtime cap the toolbar is hidden anyway. Reading it
    // would only burn the capture budget on a selection we cannot present.
    if (range.length > kAXSelectedTextMaximumLength) {
        return false;
    }

    std::string assembled;
    assembled.reserve(static_cast<size_t>(std::min(range.length, kAXStringForRangeChunkLength)));
    CFIndex offset = 0;
    while (offset < range.length && context.IsCurrent()) {
        CFIndex chunkLength = std::min(kAXStringForRangeChunkLength, range.length - offset);
        std::string chunk;
        if (!ReadStringForRange(
                element,
                CFRangeMake(range.location + offset, chunkLength),
                chunk,
                context)) {
            // A provider that answers the first chunk and then times out still
            // has a usable article prefix. Dropping it would hide the toolbar
            // for the same selection AXSelectedText already refused.
            break;
        }
        assembled.append(chunk);
        offset += chunkLength;
    }
    if (IsBlank(assembled)) {
        return false;
    }
    text = std::move(assembled);
    return true;
}

static bool SelectedTextLooksTruncated(const std::string &text, CFIndex rangeLength) {
    if (rangeLength <= 0 || text.empty()) {
        return false;
    }
    NSString *string = NSStringFromString(text);
    if (string == nil) {
        return true;
    }
    // A short explicit selection can be longer in UTF-16 than the AX string
    // when the provider inserts nothing. Only treat a large deficit as the
    // known paragraph-length AXSelectedText truncation.
    return rangeLength >= 400 && string.length + 32 < static_cast<NSUInteger>(rangeLength);
}

static bool ReadSelectedText(
    AXUIElementRef element,
    std::string &text,
    CFIndex &selectedRangeLength,
    const AccessibilityReadContext &context) {
    if (element == nullptr || !context.IsCurrent()) {
        return false;
    }

    ConfigureAccessibilityElement(element);

    CFTypeRef selectedValue = nullptr;
    AXError error = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute, &selectedValue);
    std::string selectedText;
    bool selectedTextUsable = false;
    if (error == kAXErrorSuccess && selectedValue != nullptr &&
        CFGetTypeID(selectedValue) == CFStringGetTypeID()) {
        selectedTextUsable = StringFromCFString(static_cast<CFStringRef>(selectedValue), selectedText) &&
            !IsBlank(selectedText);
    }
    if (selectedValue != nullptr) {
        CFRelease(selectedValue);
    }

    // Short selections are the common path. Trust AXSelectedText and skip the
    // extra range probe unless this string is already long enough to be the
    // known paragraph-length truncation.
    if (selectedTextUsable) {
        NSString *selected = NSStringFromString(selectedText);
        if (selected != nil && selected.length < 400) {
            text = std::move(selectedText);
            return true;
        }
    }

    selectedRangeLength = 0;
    bool hasSelectedRangeLength = false;
    if (context.IsCurrent()) {
        AXValueRef selectedRangeValue = nullptr;
        if (AXUIElementCopyAttributeValue(
                element,
                kAXSelectedTextRangeAttribute,
                reinterpret_cast<CFTypeRef *>(&selectedRangeValue)) == kAXErrorSuccess &&
            selectedRangeValue != nullptr) {
            CFRange selectedRange = CFRangeMake(0, 0);
            hasSelectedRangeLength = AXValueGetValue(
                                         selectedRangeValue,
                                         kAXValueTypeCFRange,
                                         &selectedRange) &&
                selectedRange.length > 0;
            selectedRangeLength = selectedRange.length;
            CFRelease(selectedRangeValue);
        }
    }

    if (selectedTextUsable &&
        !(hasSelectedRangeLength &&
          SelectedTextLooksTruncated(selectedText, selectedRangeLength))) {
        text = std::move(selectedText);
        return true;
    }

    if (context.IsCurrent() && ReadSelectedTextByRange(element, text, context)) {
        return true;
    }
    if (selectedTextUsable) {
        text = std::move(selectedText);
        return true;
    }

    if (!context.IsCurrent()) {
        return false;
    }

    CFTypeRef value = nullptr;
    error = AXUIElementCopyAttributeValue(element, kAXValueAttribute, &value);
    if (error != kAXErrorSuccess || value == nullptr) {
        return false;
    }
    if (CFGetTypeID(value) != CFStringGetTypeID()) {
        CFRelease(value);
        return false;
    }

    if (!context.IsCurrent()) {
        CFRelease(value);
        return false;
    }

    AXValueRef rangeValue = nullptr;
    error = AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextRangeAttribute,
        reinterpret_cast<CFTypeRef *>(&rangeValue));
    if (error != kAXErrorSuccess || rangeValue == nullptr) {
        CFRelease(value);
        return false;
    }

    CFRange range = CFRangeMake(0, 0);
    CFIndex valueLength = CFStringGetLength(static_cast<CFStringRef>(value));
    bool validRange = AXValueGetValue(rangeValue, kAXValueTypeCFRange, &range) &&
        range.location >= 0 && range.length > 0 && range.location < valueLength;
    if (validRange && range.length > valueLength - range.location) {
        range.length = valueLength - range.location;
    }

    bool success = false;
    if (validRange && range.length > 0) {
        CFStringRef substring = CFStringCreateWithSubstring(
            kCFAllocatorDefault,
            static_cast<CFStringRef>(value),
            range);
        if (substring != nullptr) {
            success = StringFromCFString(substring, text) && !IsBlank(text);
            CFRelease(substring);
        }
    }

    CFRelease(rangeValue);
    CFRelease(value);
    return success;
}

// Forward declaration because the application routing table is declared with
// the other capture policy helpers below.
static bool IsDocumentOrOfficeSelectionApplication(
    const std::string &bundleId,
    const std::string &appName);

static void ClearSelectionGeometry(SelectionInfo &info) {
    info.hasBounds = false;
    info.bounds = CGRectZero;
    info.hasStartTop = false;
    info.hasStartBottom = false;
    info.hasEndTop = false;
    info.hasEndBottom = false;
    info.startTop = CGPointZero;
    info.startBottom = CGPointZero;
    info.endTop = CGPointZero;
    info.endBottom = CGPointZero;
}

static std::string NormalizeSelectionIdentity(const std::string &value) {
    std::string normalized;
    normalized.reserve(value.size());
    for (unsigned char character : value) {
        if (std::isspace(character) != 0) {
            continue;
        }
        normalized.push_back(static_cast<char>(std::tolower(character)));
    }
    return normalized;
}

static bool WindowTitleComponentMatches(
    const std::string &title,
    const std::string &normalizedText) {
    const std::string normalizedTitle = NormalizeSelectionIdentity(title);
    if (normalizedTitle == normalizedText) {
        return true;
    }
    static const char *const separators[] = {" - ", " | ", " -- "};
    for (const char *separator : separators) {
        size_t start = 0;
        const std::string delimiter(separator);
        while (start <= title.size()) {
            size_t end = title.find(delimiter, start);
            std::string component = title.substr(start, end == std::string::npos ? end : end - start);
            if (!component.empty() && NormalizeSelectionIdentity(component) == normalizedText) {
                return true;
            }
            if (end == std::string::npos) {
                break;
            }
            start = end + delimiter.size();
        }
    }
    return false;
}

static bool SelectionTextMatchesSourceIdentity(const SelectionInfo &info) {
    if (info.text.empty() || info.text.size() > 2048) {
        return false;
    }
    const std::string normalizedText = NormalizeSelectionIdentity(info.text);
    if (normalizedText.empty()) {
        return false;
    }

    for (const std::string &candidate : {info.appName, info.bundleId}) {
        if (!candidate.empty() && NormalizeSelectionIdentity(candidate) == normalizedText) {
            return true;
        }
        const size_t separator = candidate.find_last_of("./");
        if (separator != std::string::npos &&
            NormalizeSelectionIdentity(candidate.substr(separator + 1)) == normalizedText) {
            return true;
        }
    }
    return !info.windowTitle.empty() &&
        WindowTitleComponentMatches(info.windowTitle, normalizedText);
}

static bool PointNearSelectionBounds(CGPoint point, CGRect bounds) {
    constexpr CGFloat tolerance = 56.0;
    return point.x >= CGRectGetMinX(bounds) - tolerance &&
        point.x <= CGRectGetMaxX(bounds) + tolerance &&
        point.y >= CGRectGetMinY(bounds) - tolerance &&
        point.y <= CGRectGetMaxY(bounds) + tolerance;
}

static bool SelectionCandidateMatchesInput(const SelectionInfo &candidate) {
    if (SelectionTextMatchesSourceIdentity(candidate)) {
        return false;
    }
    if (candidate.trigger == Trigger::Keyboard || candidate.trigger == Trigger::Manual) {
        return true;
    }
    if (!candidate.hasBounds) {
        // Some PDF and Office providers expose a real AXSelectedText range
        // but do not implement AXBoundsForRange. The text was read from an
        // explicit selection attribute and host/window-title values have
        // already been filtered above, so keep it rather than falling back to
        // a destructive fallback.
        return true;
    }
    return PointNearSelectionBounds(candidate.mouseCurrent, candidate.bounds) ||
        (candidate.hasMouseEnd && PointNearSelectionBounds(candidate.mouseEnd, candidate.bounds));
}

static bool ReadValidatedSelectedText(
    AXUIElementRef element,
    SelectionInfo &info,
    const AccessibilityReadContext &context) {
    std::string text;
    CFIndex selectedRangeLength = 0;
    if (!ReadSelectedText(element, text, selectedRangeLength, context)) {
        return false;
    }

    SelectionInfo candidate = info;
    ClearSelectionGeometry(candidate);
    candidate.text = std::move(text);
    candidate.selectedRangeLength = selectedRangeLength;
    ReadSelectionBounds(element, candidate, context);
    if (!SelectionCandidateMatchesInput(candidate)) {
        return false;
    }
    info = std::move(candidate);
    return true;
}

static bool FindSelectionInTree(
    AXUIElementRef element,
    SelectionInfo &info,
    int depth,
    size_t &remainingElements,
    const AccessibilityReadContext &context) {
    if (element == nullptr || depth < 0 || remainingElements == 0 || !context.IsCurrent()) {
        return false;
    }
    --remainingElements;

    ConfigureAccessibilityElement(element);

    if (ReadValidatedSelectedText(element, info, context)) {
        return true;
    }

    if (depth == 0) {
        return false;
    }
    CFArrayRef children = nullptr;
    AXError error = AXUIElementCopyAttributeValue(
        element,
        kAXChildrenAttribute,
        reinterpret_cast<CFTypeRef *>(&children));
    if (error != kAXErrorSuccess || children == nullptr) {
        return false;
    }

    bool found = false;
    CFIndex count = std::min<CFIndex>(CFArrayGetCount(children), 64);
    for (CFIndex index = 0;
         index < count && !found && remainingElements > 0 && context.IsCurrent();
         ++index) {
        AXUIElementRef child = static_cast<AXUIElementRef>(
            const_cast<void *>(CFArrayGetValueAtIndex(children, index)));
        found = FindSelectionInTree(child, info, depth - 1, remainingElements, context);
    }
    CFRelease(children);
    return found;
}

static bool FindSelectionInChildren(
    AXUIElementRef element,
    SelectionInfo &info,
    int depth,
    size_t &remainingElements,
    const AccessibilityReadContext &context) {
    if (element == nullptr || depth <= 0 || remainingElements == 0 || !context.IsCurrent()) {
        return false;
    }

    ConfigureAccessibilityElement(element);
    CFArrayRef children = nullptr;
    AXError error = AXUIElementCopyAttributeValue(
        element,
        kAXChildrenAttribute,
        reinterpret_cast<CFTypeRef *>(&children));
    if (error != kAXErrorSuccess || children == nullptr) {
        return false;
    }

    bool found = false;
    CFIndex count = std::min<CFIndex>(CFArrayGetCount(children), 64);
    for (CFIndex index = 0;
         index < count && !found && remainingElements > 0 && context.IsCurrent();
         ++index) {
        AXUIElementRef child = static_cast<AXUIElementRef>(
            const_cast<void *>(CFArrayGetValueAtIndex(children, index)));
        found = FindSelectionInTree(child, info, depth - 1, remainingElements, context);
    }
    CFRelease(children);
    return found;
}

static AXUIElementRef CopyFocusedElement(AXUIElementRef applicationElement) {
    AXUIElementRef element = nullptr;
    if (applicationElement != nullptr) {
        AXUIElementCopyAttributeValue(
            applicationElement,
            kAXFocusedUIElementAttribute,
            reinterpret_cast<CFTypeRef *>(&element));
    }
    return element;
}

static AXUIElementRef CopyFocusedWindow(AXUIElementRef applicationElement) {
    AXUIElementRef window = nullptr;
    if (applicationElement != nullptr) {
        AXUIElementCopyAttributeValue(
            applicationElement,
            kAXFocusedWindowAttribute,
            reinterpret_cast<CFTypeRef *>(&window));
    }
    return window;
}

static void ReadWindowTitle(
    AXUIElementRef window,
    std::string &title,
    const AccessibilityReadContext &context) {
    if (window == nullptr || !context.IsCurrent()) {
        return;
    }
    AXUIElementSetMessagingTimeout(window, kAXGeometryMessagingTimeoutSeconds);
    CFTypeRef value = nullptr;
    if (AXUIElementCopyAttributeValue(window, kAXTitleAttribute, &value) != kAXErrorSuccess ||
        value == nullptr) {
        return;
    }
    if (context.IsCurrent() && CFGetTypeID(value) == CFStringGetTypeID()) {
        std::string candidate;
        if (StringFromCFString(static_cast<CFStringRef>(value), candidate) &&
            !IsBlank(candidate)) {
            title = std::move(candidate);
        }
    }
    CFRelease(value);
}

static bool FindSelectionFromFocusedContext(
    AXUIElementRef element,
    SelectionInfo &info,
    const AccessibilityReadContext &context) {
    if (element == nullptr || !context.IsCurrent()) {
        return false;
    }

    if (ReadValidatedSelectedText(element, info, context)) {
        return true;
    }

    AXUIElementRef current = element;
    CFRetain(current);
    bool found = false;
    for (int level = 0; level < 10 && !found && context.IsCurrent(); ++level) {
        ConfigureAccessibilityElement(current);
        AXUIElementRef parent = nullptr;
        AXError error = AXUIElementCopyAttributeValue(
            current,
            kAXParentAttribute,
            reinterpret_cast<CFTypeRef *>(&parent));
        CFRelease(current);
        current = nullptr;
        if (error != kAXErrorSuccess || parent == nullptr) {
            break;
        }
        current = parent;
        if (ReadValidatedSelectedText(current, info, context)) {
            found = true;
        }
    }
    if (current != nullptr) CFRelease(current);
    if (found || !context.IsCurrent()) {
        return found;
    }

    // Direct focused/parent reads cover native editors and most Office/PDF
    // applications. Only then descend into a bounded child tree for WebKit,
    // Chromium, and custom canvas accessibility hierarchies.
    size_t remaining = 96;
    return FindSelectionInChildren(element, info, 4, remaining, context);
}

static bool ReadFullscreen(
    AXUIElementRef applicationElement,
    const AccessibilityReadContext &context) {
    if (applicationElement == nullptr || !context.IsCurrent()) {
        return false;
    }
    AXUIElementRef window = CopyFocusedWindow(applicationElement);
    if (window == nullptr) {
        return false;
    }
    AXUIElementSetMessagingTimeout(window, kAXGeometryMessagingTimeoutSeconds);
    CFTypeRef value = nullptr;
    AXError error = AXUIElementCopyAttributeValue(window, CFSTR("AXFullScreen"), &value);
    bool fullscreen = context.IsCurrent() && error == kAXErrorSuccess && value != nullptr &&
        CFGetTypeID(value) == CFBooleanGetTypeID() &&
        CFBooleanGetValue(static_cast<CFBooleanRef>(value));
    if (value != nullptr) CFRelease(value);
    CFRelease(window);
    return fullscreen;
}

static bool ElementIsProtected(
    AXUIElementRef element,
    const AccessibilityReadContext &context) {
    if (element == nullptr || !context.IsCurrent()) {
        return true;
    }
    ConfigureAccessibilityElement(element);

    bool isProtected = false;
    CFTypeRef subrole = nullptr;
    if (AXUIElementCopyAttributeValue(element, kAXSubroleAttribute, &subrole) == kAXErrorSuccess &&
        subrole != nullptr) {
        isProtected = CFGetTypeID(subrole) == CFStringGetTypeID() &&
            CFStringCompare(
                static_cast<CFStringRef>(subrole),
                CFSTR("AXSecureTextField"),
                0) == kCFCompareEqualTo;
        CFRelease(subrole);
    }
    if (isProtected || !context.IsCurrent()) {
        return true;
    }

    CFTypeRef protectedContent = nullptr;
    if (AXUIElementCopyAttributeValue(element, CFSTR("AXProtectedContent"), &protectedContent) ==
            kAXErrorSuccess &&
        protectedContent != nullptr) {
        isProtected = CFGetTypeID(protectedContent) == CFBooleanGetTypeID() &&
            CFBooleanGetValue(static_cast<CFBooleanRef>(protectedContent));
        CFRelease(protectedContent);
    }
    return isProtected || !context.IsCurrent();
}

constexpr uint8_t kAXEnhancedUserInterfaceApplied = 1u << 0;
constexpr uint8_t kAXManualAccessibilityApplied = 1u << 1;
constexpr uint8_t kAXCompatibilityAttributesApplied =
    kAXEnhancedUserInterfaceApplied | kAXManualAccessibilityApplied;

static uint64_t ProcessLaunchToken(NSRunningApplication *application) {
    if (application == nil || application.launchDate == nil) {
        return 0;
    }
    NSTimeInterval seconds = application.launchDate.timeIntervalSince1970;
    if (!std::isfinite(seconds) || seconds <= 0.0) {
        return 0;
    }
    return static_cast<uint64_t>(std::llround(seconds * 1'000'000.0));
}

// Tracks which AX compatibility attributes were successfully written. The
// launch token prevents a recycled PID from inheriting another app's state,
// and each attribute is retried independently when its write fails.
class EnhancedUiCache {
public:
    uint8_t Attributes(pid_t pid, uint64_t launchToken) {
        // Without a launch identity, a PID-only hit is unsafe because macOS
        // can recycle PIDs. Retry the compatibility writes for such apps
        // instead of carrying state across process lifetimes.
        if (launchToken == 0) {
            return 0;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = appliedPids_.find(pid);
        if (it == appliedPids_.end() || it->second.launchToken != launchToken) {
            if (it != appliedPids_.end()) {
                appliedPids_.erase(it);
            }
            return 0;
        }
        return it->second.attributes;
    }

    void MarkApplied(pid_t pid, uint64_t launchToken, uint8_t attributes) {
        if (attributes == 0 || launchToken == 0) {
            return;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = appliedPids_.find(pid);
        if (it == appliedPids_.end() || it->second.launchToken != launchToken) {
            if (appliedPids_.size() >= kMaxEntries) {
                appliedPids_.clear();
            }
            appliedPids_[pid] = CachedProcessState{launchToken, attributes};
            return;
        }
        it->second.attributes |= attributes;
    }

private:
    struct CachedProcessState {
        uint64_t launchToken;
        uint8_t attributes;
    };

    static constexpr size_t kMaxEntries = 256;
    std::mutex mutex_;
    std::unordered_map<pid_t, CachedProcessState> appliedPids_;
};

static bool ReadViaAccessibility(
    NSRunningApplication *application,
    SelectionInfo &info,
    uint8_t appliedAttributes,
    uint8_t &compatibilityAttributesJustApplied,
    const AccessibilityReadContext &context) {
    compatibilityAttributesJustApplied = 0;
    if (application == nil || !context.IsCurrent()) {
        return false;
    }
    AXUIElementRef applicationElement = AXUIElementCreateApplication(application.processIdentifier);
    if (applicationElement == nullptr) {
        return false;
    }
    ConfigureAccessibilityElement(applicationElement);

    AXUIElementRef focused = CopyFocusedElement(applicationElement);
    if (focused == nullptr) {
        focused = CopyFocusedWindow(applicationElement);
    }
    AXUIElementRef focusedWindow = CopyFocusedWindow(applicationElement);
    ReadWindowTitle(focusedWindow, info.windowTitle, context);

    const bool protectedFocus = focused != nullptr && ElementIsProtected(focused, context);
    bool found = false;
    if (focused != nullptr && !protectedFocus) {
        found = FindSelectionFromFocusedContext(focused, info, context);
    }
    if (!found && !protectedFocus && context.IsCurrent() && focusedWindow != nullptr &&
        (focused == nullptr || !CFEqual(focusedWindow, focused))) {
        size_t remaining = 256;
        found = FindSelectionInTree(focusedWindow, info, 5, remaining, context);
    }

    if (!protectedFocus && !found && context.IsCurrent() &&
        appliedAttributes != kAXCompatibilityAttributesApplied) {
        // Chromium/Electron often does not expose its AX tree until one of
        // these attributes is enabled. Cache only successful writes so a
        // transient AX timeout does not permanently suppress compatibility
        // setup for that process.
        if ((appliedAttributes & kAXEnhancedUserInterfaceApplied) == 0 &&
            AXUIElementSetAttributeValue(
                applicationElement,
                CFSTR("AXEnhancedUserInterface"),
                kCFBooleanTrue) == kAXErrorSuccess) {
            compatibilityAttributesJustApplied |= kAXEnhancedUserInterfaceApplied;
        }
        if ((appliedAttributes & kAXManualAccessibilityApplied) == 0 &&
            AXUIElementSetAttributeValue(
                applicationElement,
                CFSTR("AXManualAccessibility"),
                kCFBooleanTrue) == kAXErrorSuccess) {
            compatibilityAttributesJustApplied |= kAXManualAccessibilityApplied;
        }
    }

    if (found && context.IsCurrent()) {
        info.fullscreen = ReadFullscreen(applicationElement, context);
        if (context.IsCurrent()) {
            info.method = SelectionMethod::Accessibility;
        } else {
            found = false;
        }
    } else if (!context.IsCurrent()) {
        found = false;
    }
    if (focused != nullptr) CFRelease(focused);
    if (focusedWindow != nullptr) CFRelease(focusedWindow);
    CFRelease(applicationElement);
    return found;
}

static std::string LowercaseAscii(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return value;
}

static bool IsWpsSelectionApplication(
    const std::string &normalizedBundleId,
    const std::string &normalizedAppName) {
    // Regional / channel variants use several Kingsoft / WPS identifiers.
    if (normalizedBundleId.rfind("com.kingsoft.", 0) == 0 ||
        normalizedBundleId.rfind("cn.wps.", 0) == 0 ||
        normalizedBundleId.rfind("com.wps.", 0) == 0 ||
        normalizedBundleId.find("wpsoffice") != std::string::npos ||
        normalizedBundleId.find("wps-office") != std::string::npos) {
        return true;
    }
    // Fallback when bundle id is missing or atypical but the display name is
    // clearly a WPS product (Writer / Spreadsheets / Presentation / PDF).
    return normalizedAppName.find("wps") != std::string::npos ||
        normalizedAppName.find("wpsoffice") != std::string::npos ||
        normalizedAppName.find("kingsoft") != std::string::npos;
}

static bool IsDocumentOrOfficeSelectionApplication(
    const std::string &bundleId,
    const std::string &appName) {
    const std::string normalizedBundleId = LowercaseAscii(bundleId);
    const std::string normalizedAppName = LowercaseAscii(appName);
    if (IsWpsSelectionApplication(normalizedBundleId, normalizedAppName)) {
        return true;
    }
    static const char *const prefixes[] = {
        "com.adobe.",
        "com.microsoft.word",
        "com.microsoft.excel",
        "com.microsoft.powerpoint",
        "com.apple.preview",
        "com.apple.iwork.pages",
        "com.apple.iwork.numbers",
        "com.apple.iwork.keynote",
        "org.libreoffice.",
        "org.openoffice.",
    };
    for (const char *prefix : prefixes) {
        if (normalizedBundleId.rfind(prefix, 0) == 0) {
            return true;
        }
    }
    return normalizedAppName.find("acrobat") != std::string::npos ||
        normalizedAppName.find("preview") != std::string::npos ||
        normalizedAppName == "word" ||
        normalizedAppName == "excel" ||
        normalizedAppName == "powerpoint" ||
        normalizedAppName.find("libreoffice") != std::string::npos;
}

static bool IsWeChatSelectionApplication(const std::string &bundleId) {
    return LowercaseAscii(bundleId) == "com.tencent.xinwechat";
}

static bool TextHasTruncationMarker(const std::string &text) {
    NSString *string = NSStringFromString(text);
    if (string == nil || string.length < kAccessibilityMirrorBoundary) {
        return false;
    }
    if (string.length == (kAccessibilityMirrorBoundary * 2) + 1 &&
        [string characterAtIndex:kAccessibilityMirrorBoundary] == 0x2026) {
        return true;
    }
    unichar last = [string characterAtIndex:string.length - 1];
    if (last == 0x2026 || last == 0x22EF) {
        return true;
    }
    return string.length >= 3 &&
        [[string substringFromIndex:string.length - 3] isEqualToString:@"..."];
}

static bool AccessibilityMirrorReachesBoundary(const std::string &text) {
    NSString *string = NSStringFromString(text);
    return string != nil && string.length >= kAccessibilityMirrorBoundary;
}

static bool SelectedRangeExceedsText(const std::string &text, CFIndex rangeLength) {
    NSString *string = NSStringFromString(text);
    return string != nil && rangeLength > 0 &&
        static_cast<NSUInteger>(rangeLength) > string.length + 8;
}

static bool HasTruncatedAccessibilityMirror(const std::string &text) {
    return TextHasTruncationMarker(text) || AccessibilityMirrorReachesBoundary(text);
}

static bool HasFocusedTextSelection(
    NSRunningApplication *application,
    const AccessibilityReadContext &context) {
    if (application == nil || !context.IsCurrent()) {
        return false;
    }
    AXUIElementRef applicationElement = AXUIElementCreateApplication(application.processIdentifier);
    if (applicationElement == nullptr) {
        return false;
    }
    ConfigureAccessibilityElement(applicationElement);
    AXUIElementRef focused = CopyFocusedElement(applicationElement);
    CFRelease(applicationElement);
    if (focused == nullptr) {
        return false;
    }
    ConfigureAccessibilityElement(focused);
    if (ElementIsProtected(focused, context)) {
        CFRelease(focused);
        return false;
    }

    bool hasSelection = false;
    CFTypeRef selectedValue = nullptr;
    if (AXUIElementCopyAttributeValue(focused, kAXSelectedTextAttribute, &selectedValue) ==
            kAXErrorSuccess &&
        selectedValue != nullptr && CFGetTypeID(selectedValue) == CFStringGetTypeID()) {
        std::string selectedText;
        hasSelection = StringFromCFString(static_cast<CFStringRef>(selectedValue), selectedText) &&
            !IsBlank(selectedText);
    }
    if (selectedValue != nullptr) {
        CFRelease(selectedValue);
    }

    if (!hasSelection && context.IsCurrent()) {
        AXValueRef rangeValue = nullptr;
        if (AXUIElementCopyAttributeValue(
                focused,
                kAXSelectedTextRangeAttribute,
                reinterpret_cast<CFTypeRef *>(&rangeValue)) == kAXErrorSuccess &&
            rangeValue != nullptr) {
            CFRange range = CFRangeMake(0, 0);
            hasSelection = AXValueGetValue(rangeValue, kAXValueTypeCFRange, &range) &&
                range.location >= 0 && range.length > 0;
        }
        if (rangeValue != nullptr) {
            CFRelease(rangeValue);
        }
    }
    CFRelease(focused);
    return hasSelection && context.IsCurrent();
}

static bool FocusedElementIsProtected(
    NSRunningApplication *application,
    const AccessibilityReadContext &context) {
    if (application == nil || !context.IsCurrent()) {
        return true;
    }
    AXUIElementRef applicationElement = AXUIElementCreateApplication(application.processIdentifier);
    if (applicationElement == nullptr) {
        return true;
    }
    ConfigureAccessibilityElement(applicationElement);
    AXUIElementRef focused = CopyFocusedElement(applicationElement);
    CFRelease(applicationElement);
    if (focused == nullptr) {
        // Custom-rendered document canvases often have no focused text element.
        return false;
    }
    ConfigureAccessibilityElement(focused);
    const bool isProtected = ElementIsProtected(focused, context);
    CFRelease(focused);
    return isProtected;
}

static bool RestoreClipboardBackup(
    NSPasteboard *pasteboard,
    NSArray<NSPasteboardItem *> *backup,
    NSInteger expectedChangeCount) {
    if (pasteboard == nil || backup == nil ||
        pasteboard.changeCount != expectedChangeCount) {
        return false;
    }
    [pasteboard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
    return backup.count == 0 || [pasteboard writeObjects:backup];
}

static bool ReadSelectionViaClipboard(
    NSRunningApplication *application,
    bool hasAccessibilitySelection,
    const std::string &accessibilityText,
    bool requireFocusedSelectionEvidence,
    std::string &text,
    const AccessibilityReadContext &context) {
    if (application == nil || !context.IsCurrent()) {
        TraceDecision("copy: reject nil-app=%d ctxCurrent=%d",
            application == nil ? 1 : 0,
            context.IsCurrent() ? 1 : 0);
        return false;
    }
    if (requireFocusedSelectionEvidence) {
        if (!hasAccessibilitySelection && !HasFocusedTextSelection(application, context)) {
            TraceDecision("copy: reject no-selection-evidence");
            return false;
        }
    } else if (FocusedElementIsProtected(application, context)) {
        TraceDecision("copy: reject protected");
        return false;
    }
    NSRunningApplication *frontmost = FrontmostApplication();
    if (frontmost == nil || frontmost.processIdentifier != application.processIdentifier) {
        TraceDecision("copy: reject frontmost-mismatch");
        return false;
    }

    @autoreleasepool {
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        const NSInteger originalChangeCount = pasteboard.changeCount;
        NSArray<NSPasteboardItem *> *originalItems = pasteboard.pasteboardItems;
        NSMutableArray<NSPasteboardItem *> *backup = [NSMutableArray array];
        NSUInteger backupBytes = 0;

        // Materialize every representation before copying. If any promised data
        // cannot be read, abort rather than destroying an incomplete backup.
        for (NSPasteboardItem *item in originalItems) {
            NSPasteboardItem *itemCopy = [[NSPasteboardItem alloc] init];
            for (NSPasteboardType type in item.types) {
                NSData *data = [item dataForType:type];
                if (data == nil || data.length > kMaximumClipboardBackupBytes - backupBytes) {
                    TraceDecision("copy: reject backup-unreadable");
                    return false;
                }
                backupBytes += data.length;
                [itemCopy setData:data forType:type];
            }
            [backup addObject:itemCopy];
        }
        if (!context.IsCurrent() || pasteboard.changeCount != originalChangeCount) {
            TraceDecision("copy: reject backup-raced ctxCurrent=%d",
                context.IsCurrent() ? 1 : 0);
            return false;
        }

        SyntheticCopyGuard syntheticCopyGuard;
        CGEventRef keyDown = CGEventCreateKeyboardEvent(nullptr, kVK_ANSI_C, true);
        CGEventRef keyUp = CGEventCreateKeyboardEvent(nullptr, kVK_ANSI_C, false);
        if (keyDown == nullptr || keyUp == nullptr) {
            if (keyDown != nullptr) CFRelease(keyDown);
            if (keyUp != nullptr) CFRelease(keyUp);
            TraceDecision("copy: reject event-create-failed");
            return false;
        }
        for (CGEventRef event : {keyDown, keyUp}) {
            CGEventSetFlags(event, kCGEventFlagMaskCommand);
            CGEventSetIntegerValueField(
                event,
                kCGEventSourceUserData,
                kSyntheticCopyEventMarker);
        }
        // Deliver to the frontmost process and through the HID stream. PID
        // delivery misses Electron renderers; HID alone can be swallowed before
        // it reaches the focused editor. The in-flight guard above keeps this
        // process's own tap from cancelling the capture.
        CGEventPostToPid(application.processIdentifier, keyDown);
        CGEventPostToPid(application.processIdentifier, keyUp);
        CGEventPost(kCGHIDEventTap, keyDown);
        CGEventPost(kCGHIDEventTap, keyUp);
        CFRelease(keyDown);
        CFRelease(keyUp);
        const uint64_t copyWaitStartedAt = MonotonicMilliseconds();

        NSInteger copiedChangeCount = originalChangeCount;
        while (context.IsCurrent()) {
            copiedChangeCount = pasteboard.changeCount;
            if (copiedChangeCount != originalChangeCount) {
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(4));
        }
        if (copiedChangeCount == originalChangeCount) {
            copiedChangeCount = pasteboard.changeCount;
            if (copiedChangeCount == originalChangeCount) {
                TraceDecision(
                    "copy: no-change after %llums ctxCurrent=%d",
                    static_cast<unsigned long long>(MonotonicMilliseconds() - copyWaitStartedAt),
                    context.IsCurrent() ? 1 : 0);
                return false;
            }
        }
        TraceDecision(
            "copy: changed after %llums",
            static_cast<unsigned long long>(MonotonicMilliseconds() - copyWaitStartedAt));

        const bool copyWasCurrent = pasteboard.changeCount == copiedChangeCount;
        NSString *copied = copyWasCurrent ? [pasteboard stringForType:NSPasteboardTypeString] : nil;
        const std::string copiedText = StringFromNSString(copied);
        const bool copyIsCurrent = copyWasCurrent &&
            pasteboard.changeCount == copiedChangeCount;
        const bool sourceChanged = FrontmostApplication().processIdentifier != application.processIdentifier;

        // Restore only while the pasteboard still contains this transaction's
        // copy. A newer user clipboard write must never be overwritten.
        if (copyIsCurrent &&
            !RestoreClipboardBackup(pasteboard, backup, copiedChangeCount)) {
            TraceDecision("copy: reject restore-failed");
            return false;
        }
        if (!copyIsCurrent || sourceChanged || IsBlank(copiedText) || !context.IsCurrent()) {
            TraceDecision(
                "copy: reject post-copy copyIsCurrent=%d sourceChanged=%d blank=%d ctxCurrent=%d",
                copyIsCurrent ? 1 : 0,
                sourceChanged ? 1 : 0,
                IsBlank(copiedText) ? 1 : 0,
                context.IsCurrent() ? 1 : 0);
            return false;
        }
        NSString *copiedString = NSStringFromString(copiedText);
        NSString *accessibilityString = NSStringFromString(accessibilityText);
        const bool copiedExtendsMirror = copiedString != nil && accessibilityString != nil &&
            copiedString.length > accessibilityString.length;
        if (hasAccessibilitySelection && copiedText != accessibilityText &&
            !HasTruncatedAccessibilityMirror(accessibilityText) &&
            !copiedExtendsMirror) {
            // Do not replace a valid AX selection with a shorter, unrelated
            // clipboard value if the host changed its selection concurrently.
            TraceDecision("copy: reject mirror-mismatch copiedLen=%zu axLen=%zu",
                copiedText.size(),
                accessibilityText.size());
            return false;
        }
        TraceDecision("copy: accepted copiedLen=%zu restored=%d",
            copiedText.size(),
            copyIsCurrent ? 1 : 0);
        text = copiedText;
        return true;
    }
}

static bool CaptureSelection(
    const std::string &excludedBundleId,
    Trigger trigger,
    CGPoint mouseStart,
    bool hasMouseStart,
    CGPoint mouseEnd,
    bool hasMouseEnd,
    CGPoint currentMouse,
    SelectionInfo &info,
    EnhancedUiCache &enhancedUiCache,
    const std::atomic<uint64_t> *captureGeneration = nullptr,
    uint64_t expectedGeneration = 0) {
    @autoreleasepool {
        if (!AXIsProcessTrusted()) {
            return false;
        }
        NSRunningApplication *application = FrontmostApplication();
        if (IsExcludedApplication(application, excludedBundleId)) {
            return false;
        }

        info.bundleId = StringFromNSString(application.bundleIdentifier);
        info.appName = StringFromNSString(application.localizedName);
        info.trigger = trigger;
        info.mouseStart = mouseStart;
        info.mouseEnd = mouseEnd;
        info.mouseCurrent = currentMouse;
        info.hasMouseStart = hasMouseStart;
        info.hasMouseEnd = hasMouseEnd;

        pid_t pid = application.processIdentifier;
        uint64_t launchToken = ProcessLaunchToken(application);
        uint8_t appliedAttributes = enhancedUiCache.Attributes(pid, launchToken);
        uint8_t compatibilityAttributesJustApplied = 0;
        const bool documentOrOffice = IsDocumentOrOfficeSelectionApplication(
            info.bundleId,
            info.appName);
        const uint64_t budgetMs = documentOrOffice
            ? kDocumentAXCaptureBudgetMs
            : kAXCaptureBudgetMs;
        const AccessibilityReadContext context{
            captureGeneration,
            expectedGeneration,
            MonotonicMilliseconds() + budgetMs,
        };
        if (!context.IsCurrent()) return false;

        bool found = ReadViaAccessibility(
            application,
            info,
            appliedAttributes,
            compatibilityAttributesJustApplied,
            context);
        const bool shouldRetry = !found && context.IsCurrent() &&
            (compatibilityAttributesJustApplied != 0 || documentOrOffice);
        if (shouldRetry) {
            // Chromium/Electron needs a short turn after compatibility
            // attributes are set. Document canvases likewise commonly publish
            // their selection a frame after mouse-up. Keep the retry
            // cancellable and inside this request's existing AX budget.
            const uint64_t retryDelay = compatibilityAttributesJustApplied != 0
                ? kAXCompatibilityRetryDelayMs
                : kAXLateSelectionRetryDelayMs;
            const uint64_t retryAt = std::min(
                context.deadlineMs,
                MonotonicMilliseconds() + retryDelay);
            while (context.IsCurrent() && MonotonicMilliseconds() < retryAt) {
                std::this_thread::sleep_for(std::chrono::milliseconds(4));
            }
            if (context.IsCurrent()) {
                uint8_t retryJustApplied = 0;
                found = ReadViaAccessibility(
                    application,
                    info,
                    static_cast<uint8_t>(appliedAttributes | compatibilityAttributesJustApplied),
                    retryJustApplied,
                    context);
                compatibilityAttributesJustApplied |= retryJustApplied;
            }
        }
        if (compatibilityAttributesJustApplied != 0) {
            enhancedUiCache.MarkApplied(pid, launchToken, compatibilityAttributesJustApplied);
        }

        const bool accessibilityContextCurrent = context.IsCurrent();
        bool clipboardCaptured = false;
        // Generic fallback for hosts whose accessibility mirror is truncated or
        // missing. A real selection must already be visible: either AX returned
        // a bounded mirror, or the focused element still exposes a non-empty
        // selected range. Short complete selections never reach this path.
        const bool hasMarker = TextHasTruncationMarker(info.text);
        const bool rangeExceedsText =
            SelectedRangeExceedsText(info.text, info.selectedRangeLength);
        const bool dragReachesBoundary = info.trigger == Trigger::Drag &&
            AccessibilityMirrorReachesBoundary(info.text);
        const bool mirrorNeedsCopy =
            found && (hasMarker || rangeExceedsText || dragReachesBoundary);
        // Chromium-family editors publish an empty mirror for long selections:
        // the hidden textarea behind Monaco keeps no value once the selection
        // passes the screen-reader paging limit, so AXSelectedText and
        // AXSelectedTextRange both come back empty. A real drag gesture with
        // drag distance and duration already validated is itself evidence that
        // a selection exists, independent of what AX publishes.
        const bool dragImpliesSelection = !found && accessibilityContextCurrent &&
            info.trigger == Trigger::Drag &&
            !FocusedElementIsProtected(application, context);
        const bool focusedSelectionEvidence = !found && accessibilityContextCurrent &&
            HasFocusedTextSelection(application, context);
        const bool missingTextHasSelection =
            dragImpliesSelection || focusedSelectionEvidence;
        TraceDecision(
            "gate trigger=%d found=%d textLen=%zu rangeLen=%ld ctxCurrent=%d "
            "marker=%d rangeExceeds=%d dragBoundary=%d mirrorNeedsCopy=%d "
            "dragImplies=%d focusedSelEvidence=%d",
            static_cast<int>(info.trigger),
            found ? 1 : 0,
            info.text.size(),
            static_cast<long>(info.selectedRangeLength),
            accessibilityContextCurrent ? 1 : 0,
            hasMarker ? 1 : 0,
            rangeExceedsText ? 1 : 0,
            dragReachesBoundary ? 1 : 0,
            mirrorNeedsCopy ? 1 : 0,
            dragImpliesSelection ? 1 : 0,
            focusedSelectionEvidence ? 1 : 0);
        if (!IsWeChatSelectionApplication(info.bundleId) &&
            (mirrorNeedsCopy || missingTextHasSelection)) {
            const AccessibilityReadContext clipboardContext{
                captureGeneration,
                expectedGeneration,
                MonotonicMilliseconds() + kClipboardCaptureBudgetMs,
            };
            std::string copiedText;
            if (ReadSelectionViaClipboard(
                    application,
                    found || missingTextHasSelection,
                    info.text,
                    true,
                    copiedText,
                    clipboardContext)) {
                if (!found) {
                    ClearSelectionGeometry(info);
                }
                info.text = std::move(copiedText);
                info.method = SelectionMethod::Clipboard;
                found = SelectionCandidateMatchesInput(info);
                clipboardCaptured = found;
            }
        }
        if (!found && IsWeChatSelectionApplication(info.bundleId)) {
            const AccessibilityReadContext clipboardContext{
                captureGeneration,
                expectedGeneration,
                MonotonicMilliseconds() + kWeChatClipboardCaptureBudgetMs,
            };
            std::string copiedText;
            if (ReadSelectionViaClipboard(
                    application,
                    false,
                    "",
                    false,
                    copiedText,
                    clipboardContext)) {
                ClearSelectionGeometry(info);
                info.text = std::move(copiedText);
                info.method = SelectionMethod::Clipboard;
                found = SelectionCandidateMatchesInput(info);
                clipboardCaptured = found;
            }
        }
        TraceDecision(
            "result bundle=%s trigger=%d found=%d method=%s textLen=%zu",
            info.bundleId.c_str(),
            static_cast<int>(info.trigger),
            found ? 1 : 0,
            info.method == SelectionMethod::Clipboard ? "clipboard" : "accessibility",
            info.text.size());
        return found && (accessibilityContextCurrent || clipboardCaptured) && !IsBlank(info.text);
    }
}

static NSDictionary *PointObject(CGPoint point) {
    return @{ @"x": @(point.x), @"y": @(point.y) };
}

static id OptionalPoint(bool present, CGPoint point) {
    return present ? PointObject(point) : [NSNull null];
}

static NSString *TriggerName(Trigger trigger) {
    switch (trigger) {
        case Trigger::Drag: return @"drag";
        case Trigger::DoubleClick: return @"doubleClick";
        case Trigger::ShiftClick: return @"shiftClick";
        case Trigger::Keyboard: return @"keyboard";
        case Trigger::Manual: return @"manual";
    }
}

static NSString *SelectionDirection(const SelectionInfo &info) {
    if (!info.hasMouseStart || !info.hasMouseEnd) {
        return @"unknown";
    }
    double deltaY = info.mouseEnd.y - info.mouseStart.y;
    double deltaX = info.mouseEnd.x - info.mouseStart.x;
    if (std::abs(deltaY) > 2.0) {
        return deltaY > 0 ? @"forward" : @"backward";
    }
    if (std::abs(deltaX) > 0.5) {
        return deltaX > 0 ? @"forward" : @"backward";
    }
    return @"unknown";
}

static std::string SerializeJSONObject(NSDictionary *object) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (data == nil || error != nil) {
        return {};
    }
    return std::string(static_cast<const char *>(data.bytes), data.length);
}

static std::string SelectionJSON(const SelectionInfo &info) {
    NSString *text = NSStringFromString(info.text);
    NSString *bundle = NSStringFromString(info.bundleId);
    NSString *name = NSStringFromString(info.appName);
    if (text == nil || bundle == nil) {
        return {};
    }

    id bounds = [NSNull null];
    if (info.hasBounds) {
        bounds = @{
            @"x": @(info.bounds.origin.x),
            @"y": @(info.bounds.origin.y),
            @"width": @(info.bounds.size.width),
            @"height": @(info.bounds.size.height),
        };
    }

    NSDictionary *object = @{
        @"type": @"selection",
        @"text": text,
        @"sourceApp": @{
            @"bundleId": bundle,
            @"name": name ?: bundle,
        },
        @"bounds": bounds,
        @"startTop": OptionalPoint(info.hasStartTop, info.startTop),
        @"startBottom": OptionalPoint(info.hasStartBottom, info.startBottom),
        @"endTop": OptionalPoint(info.hasEndTop, info.endTop),
        @"endBottom": OptionalPoint(info.hasEndBottom, info.endBottom),
        @"mouse": @{
            @"start": OptionalPoint(info.hasMouseStart, info.mouseStart),
            @"end": OptionalPoint(info.hasMouseEnd, info.mouseEnd),
            @"current": PointObject(info.mouseCurrent),
        },
        @"direction": SelectionDirection(info),
        @"isFullscreen": @(info.fullscreen),
        @"method": info.method == SelectionMethod::Clipboard ? @"clipboard" : @"accessibility",
        @"trigger": TriggerName(info.trigger),
        @"timestampMs": @(TimestampMilliseconds()),
    };
    return SerializeJSONObject(object);
}

static std::string DismissJSON(const Task &task) {
    NSString *reason = NSStringFromString(task.dismissReason);
    if (reason == nil) {
        return {};
    }
    return SerializeJSONObject(@{
        @"type": @"dismiss",
        @"reason": reason,
        @"mouse": PointObject(task.mouseCurrent),
        @"targetPid": @(task.targetPid),
        @"timestampMs": @(TimestampMilliseconds()),
    });
}

static bool IsKeyboardSelectionKey(CGKeyCode keyCode) {
    switch (keyCode) {
        case kVK_LeftArrow:
        case kVK_RightArrow:
        case kVK_UpArrow:
        case kVK_DownArrow:
        case kVK_Home:
        case kVK_End:
        case kVK_PageUp:
        case kVK_PageDown:
            return true;
        default:
            return false;
    }
}

static bool IsModifierKey(CGKeyCode keyCode) {
    switch (keyCode) {
        case kVK_Shift:
        case kVK_RightShift:
        case kVK_Command:
        case kVK_RightCommand:
        case kVK_Control:
        case kVK_RightControl:
        case kVK_Option:
        case kVK_RightOption:
        case kVK_CapsLock:
        case kVK_Function:
            return true;
        default:
            return false;
    }
}

// Collapse the focused AX selection to a caret at the end of the former range
// when the selected text still exactly matches `expectedText`. Optional
// `requiredBundleId` rejects apps that are not the original host.
static uint8_t ClearMatchingTextOnMainThread(
    const std::string &requiredBundleId,
    const std::string &expectedText) {
    @autoreleasepool {
        if (expectedText.empty() || !AXIsProcessTrusted()) {
            return 0;
        }

        NSRunningApplication *application = FrontmostApplication();
        if (application == nil || application.processIdentifier == getpid()) {
            return 0;
        }

        std::string appBundleId = StringFromNSString(application.bundleIdentifier);
        if (!requiredBundleId.empty() && appBundleId != requiredBundleId) {
            return 0;
        }

        AXUIElementRef applicationElement =
            AXUIElementCreateApplication(application.processIdentifier);
        if (applicationElement == nullptr) {
            return 0;
        }
        AXUIElementSetMessagingTimeout(applicationElement, kAXMessagingTimeoutSeconds);

        AXUIElementRef focused = CopyFocusedElement(applicationElement);
        CFRelease(applicationElement);
        if (focused == nullptr) {
            return 0;
        }

        const AccessibilityReadContext context{
            nullptr,
            0,
            MonotonicMilliseconds() +
                static_cast<uint64_t>(kAXMessagingTimeoutSeconds * 1'000.0f),
        };
        std::string current;
        CFIndex selectedRangeLength = 0;
        if (!ReadSelectedText(focused, current, selectedRangeLength, context) ||
            current != expectedText) {
            CFRelease(focused);
            return 0;
        }

        AXValueRef selectedRangeValue = nullptr;
        AXError error = AXUIElementCopyAttributeValue(
            focused,
            kAXSelectedTextRangeAttribute,
            reinterpret_cast<CFTypeRef *>(&selectedRangeValue));
        if (error != kAXErrorSuccess || selectedRangeValue == nullptr) {
            CFRelease(focused);
            return 0;
        }

        CFRange range = CFRangeMake(0, 0);
        bool hasRange = AXValueGetValue(selectedRangeValue, kAXValueTypeCFRange, &range) &&
            range.location >= 0 &&
            range.length > 0 &&
            range.length <= std::numeric_limits<CFIndex>::max() - range.location;
        CFRelease(selectedRangeValue);
        if (!hasRange) {
            CFRelease(focused);
            return 0;
        }

        // Caret at the end of the former selection (natural "deselect after read").
        CFRange collapsed = CFRangeMake(range.location + range.length, 0);
        AXValueRef collapsedValue = AXValueCreate(kAXValueTypeCFRange, &collapsed);
        if (collapsedValue == nullptr) {
            CFRelease(focused);
            return 0;
        }

        error = AXUIElementSetAttributeValue(
            focused,
            kAXSelectedTextRangeAttribute,
            collapsedValue);
        CFRelease(collapsedValue);
        CFRelease(focused);
        return error == kAXErrorSuccess ? 1 : 0;
    }
}

} // namespace

struct TextLensSelectionMonitor {
    explicit TextLensSelectionMonitor(
        std::string excludedBundle,
        TextLensSelectionEventCallback eventCallback,
        void *eventContext)
        : excludedBundleId(std::move(excludedBundle)),
          callback(eventCallback),
          callbackContext(eventContext) {}

    ~TextLensSelectionMonitor() {
        stop();
        std::lock_guard<std::mutex> lock(callbackMutex);
        callback = nullptr;
        callbackContext = nullptr;
    }

    int32_t start() {
        std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex);
        if (running.load(std::memory_order_acquire)) {
            return TEXTLENS_SELECTION_ALREADY_RUNNING;
        }
        if (!AXIsProcessTrusted()) {
            return TEXTLENS_SELECTION_NOT_TRUSTED;
        }

        {
            std::lock_guard<std::mutex> startupLock(startupMutex);
            startupReady = false;
            startupStatus = TEXTLENS_SELECTION_INTERNAL_ERROR;
        }
        {
            std::lock_guard<std::mutex> runLoopLock(runLoopMutex);
            eventRunLoop = nullptr;
        }
        {
            std::lock_guard<std::mutex> taskLock(taskMutex);
            tasks.clear();
        }
        {
            std::lock_guard<std::mutex> dismissLock(dismissMutex);
            dismissTasks.clear();
        }
        keyboardSelectionPending = false;
        running.store(true, std::memory_order_release);

        try {
            workerThread = std::thread(&TextLensSelectionMonitor::workerMain, this);
            dismissThread = std::thread(&TextLensSelectionMonitor::dismissMain, this);
            eventThread = std::thread(&TextLensSelectionMonitor::eventMain, this);
        } catch (...) {
            running.store(false, std::memory_order_release);
            taskCondition.notify_all();
            dismissCondition.notify_all();
            if (eventThread.joinable()) eventThread.join();
            if (dismissThread.joinable()) dismissThread.join();
            if (workerThread.joinable()) workerThread.join();
            return TEXTLENS_SELECTION_INTERNAL_ERROR;
        }

        int32_t status = TEXTLENS_SELECTION_INTERNAL_ERROR;
        {
            std::unique_lock<std::mutex> startupLock(startupMutex);
            startupCondition.wait(startupLock, [this] { return startupReady; });
            status = startupStatus;
        }
        if (status != TEXTLENS_SELECTION_OK) {
            running.store(false, std::memory_order_release);
            taskCondition.notify_all();
            dismissCondition.notify_all();
            if (eventThread.joinable()) eventThread.join();
            if (dismissThread.joinable()) dismissThread.join();
            if (workerThread.joinable()) workerThread.join();
        }
        return status;
    }

    int32_t stop() {
        std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex);
        bool wasRunning = running.exchange(false, std::memory_order_acq_rel);
        {
            std::lock_guard<std::mutex> runLoopLock(runLoopMutex);
            if (eventRunLoop != nullptr) {
                CFRunLoopStop(eventRunLoop);
                CFRunLoopWakeUp(eventRunLoop);
            }
        }
        taskCondition.notify_all();
        dismissCondition.notify_all();
        if (eventThread.joinable()) eventThread.join();
        if (dismissThread.joinable()) dismissThread.join();
        if (workerThread.joinable()) workerThread.join();
        {
            std::lock_guard<std::mutex> taskLock(taskMutex);
            tasks.clear();
        }
        {
            std::lock_guard<std::mutex> dismissLock(dismissMutex);
            dismissTasks.clear();
        }
        return wasRunning ? TEXTLENS_SELECTION_OK : TEXTLENS_SELECTION_NOT_RUNNING;
    }

    bool captureCurrent(SelectionInfo &info) {
        std::lock_guard<std::mutex> captureLock(captureMutex);
        CGPoint mouse = CurrentMousePosition();
        return CaptureSelection(
            excludedBundleId,
            Trigger::Manual,
            mouse,
            false,
            mouse,
            false,
            mouse,
            info,
            enhancedUiCache);
    }

    static CGEventRef eventTapCallback(
        CGEventTapProxy,
        CGEventType type,
        CGEventRef event,
        void *context) {
        auto *monitor = static_cast<TextLensSelectionMonitor *>(context);
        if (monitor == nullptr || !monitor->running.load(std::memory_order_acquire)) {
            return event;
        }
        const bool syntheticCopy = gSyntheticCopyPosts.load(std::memory_order_acquire) != 0 &&
            (type == kCGEventKeyDown || type == kCGEventKeyUp || type == kCGEventFlagsChanged);
        if (syntheticCopy ||
            CGEventGetIntegerValueField(event, kCGEventSourceUserData) ==
                kSyntheticCopyEventMarker) {
            return event;
        }
        if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
            if (monitor->eventTap != nullptr) {
                CGEventTapEnable(monitor->eventTap, true);
            }
            return event;
        }
        monitor->handleEvent(type, event);
        return event;
    }

    // Reactive re-enable in eventTapCallback only fires on the next incoming
    // event; if the tap is disabled with no further events arriving (e.g. a
    // sustained high event-rate burst tripped the OS-side rate limit),
    // capture would otherwise stay silent until app restart. This periodic
    // check gives the same self-healing Windows already has for its hook.
    static void HealthCheckTimerCallback(CFRunLoopTimerRef, void *context) {
        auto *monitor = static_cast<TextLensSelectionMonitor *>(context);
        if (monitor == nullptr || !monitor->running.load(std::memory_order_acquire)) {
            return;
        }
        if (monitor->eventTap != nullptr && !CGEventTapIsEnabled(monitor->eventTap)) {
            CGEventTapEnable(monitor->eventTap, true);
        }
    }

    void handleEvent(CGEventType type, CGEventRef event) {
        const int64_t targetPid = CGEventGetIntegerValueField(event, kCGEventTargetUnixProcessID);
        // Clicks/scrolls targeting TextLens itself must still dismiss an open
        // toolbar (e.g. re-select toolbar over the result webview). Runtime
        // ignores dismiss points that land on the no-activate toolbar window.
        // Never schedule selection capture for the own process.
        if (targetPid == getpid()) {
            if (type == kCGEventLeftMouseDown ||
                type == kCGEventRightMouseDown ||
                type == kCGEventOtherMouseDown) {
                const CGPoint point = CGEventGetLocation(event);
                captureGeneration.fetch_add(1, std::memory_order_acq_rel);
                enqueueDismiss("mouseDown", point, targetPid);
            } else if (type == kCGEventScrollWheel) {
                const CGPoint point = CGEventGetLocation(event);
                captureGeneration.fetch_add(1, std::memory_order_acq_rel);
                enqueueDismiss("scroll", point, targetPid);
            }
            return;
        }
        const CGPoint point = CGEventGetLocation(event);
        const uint64_t now = MonotonicMilliseconds();

        switch (type) {
            case kCGEventLeftMouseDown: {
                captureGeneration.fetch_add(1, std::memory_order_acq_rel);
                mouseDown = point;
                mouseDownTime = now;
                enqueueDismiss("mouseDown", point, targetPid);
                break;
            }
            case kCGEventRightMouseDown:
            case kCGEventOtherMouseDown:
                captureGeneration.fetch_add(1, std::memory_order_acq_rel);
                enqueueDismiss("mouseDown", point, targetPid);
                break;
            case kCGEventScrollWheel:
                captureGeneration.fetch_add(1, std::memory_order_acq_rel);
                enqueueDismiss("scroll", point, targetPid);
                break;
            case kCGEventLeftMouseUp: {
                uint64_t duration = now >= mouseDownTime ? now - mouseDownTime : 0;
                double distance = std::hypot(point.x - mouseDown.x, point.y - mouseDown.y);
                double previousDistance = std::hypot(point.x - lastMouseUp.x, point.y - lastMouseUp.y);
                int64_t clickCount = CGEventGetIntegerValueField(event, kCGMouseEventClickState);
                CGEventFlags flags = CGEventGetFlags(event);

                Trigger trigger = Trigger::Manual;
                bool shouldCapture = false;
                CGPoint start = mouseDown;
                if (duration <= kMaximumDragDurationMs && distance >= kMinimumDragDistance) {
                    trigger = Trigger::Drag;
                    shouldCapture = true;
                } else if (clickCount >= 2 ||
                    (lastClickWasValid && now - lastMouseUpTime <= kDoubleClickDurationMs &&
                     previousDistance <= kDoubleClickDistance)) {
                    trigger = Trigger::DoubleClick;
                    start = point;
                    shouldCapture = true;
                } else {
                    bool shiftOnly = (flags & kCGEventFlagMaskShift) != 0 &&
                        (flags & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl |
                                  kCGEventFlagMaskAlternate)) == 0;
                    if (shiftOnly) {
                        trigger = Trigger::ShiftClick;
                        start = lastMouseUp;
                        shouldCapture = true;
                    }
                }

                lastClickWasValid = duration <= kDoubleClickDurationMs;
                lastMouseUp = point;
                lastMouseUpTime = now;
                if (shouldCapture) {
                    enqueueCapture(trigger, start, true, point, true, point);
                }
                break;
            }
            case kCGEventKeyDown: {
                CGKeyCode keyCode = static_cast<CGKeyCode>(
                    CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
                CGEventFlags flags = CGEventGetFlags(event);
                bool extendsWithShift = (flags & kCGEventFlagMaskShift) != 0 &&
                    IsKeyboardSelectionKey(keyCode);
                bool selectAll = (flags & kCGEventFlagMaskCommand) != 0 &&
                    (flags & (kCGEventFlagMaskControl | kCGEventFlagMaskAlternate)) == 0 &&
                    keyCode == kVK_ANSI_A;
                if (extendsWithShift || selectAll) {
                    keyboardSelectionPending = true;
                    keyboardSelectionKey = keyCode;
                }
                if (!IsModifierKey(keyCode)) {
                    captureGeneration.fetch_add(1, std::memory_order_acq_rel);
                    enqueueDismiss("keyDown", point, targetPid);
                }
                break;
            }
            case kCGEventKeyUp: {
                CGKeyCode keyCode = static_cast<CGKeyCode>(
                    CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
                if (keyboardSelectionPending && keyCode == keyboardSelectionKey) {
                    keyboardSelectionPending = false;
                    enqueueCapture(Trigger::Keyboard, point, false, point, false, point);
                }
                break;
            }
            default:
                break;
        }
    }

    void enqueueCapture(
        Trigger trigger,
        CGPoint start,
        bool hasStart,
        CGPoint end,
        bool hasEnd,
        CGPoint current) {
        Task task;
        task.kind = TaskKind::Capture;
        task.trigger = trigger;
        task.mouseStart = start;
        task.mouseEnd = end;
        task.mouseCurrent = current;
        task.hasMouseStart = hasStart;
        task.hasMouseEnd = hasEnd;
        task.generation = captureGeneration.fetch_add(1, std::memory_order_acq_rel) + 1;
        task.enqueuedAtMs = MonotonicMilliseconds();
        enqueueTask(std::move(task));
    }

    void enqueueDismiss(const char *reason, CGPoint point, int64_t targetPid) {
        Task task;
        task.kind = TaskKind::Dismiss;
        task.dismissReason = reason;
        task.mouseCurrent = point;
        task.targetPid = targetPid;
        if (!running.load(std::memory_order_acquire)) {
            return;
        }
        {
            std::lock_guard<std::mutex> lock(dismissMutex);
            if (dismissTasks.size() >= kMaximumQueuedTasks) {
                dismissTasks.pop_front();
            }
            if (!dismissTasks.empty() &&
                dismissTasks.back().dismissReason == task.dismissReason) {
                dismissTasks.back() = std::move(task);
            } else {
                dismissTasks.push_back(std::move(task));
            }
        }
        dismissCondition.notify_one();
    }

    void enqueueTask(Task task) {
        if (!running.load(std::memory_order_acquire) || task.kind != TaskKind::Capture) {
            return;
        }
        {
            std::lock_guard<std::mutex> lock(taskMutex);
            // Capture is latest-wins. A task already executing may finish its
            // bounded AX transaction, but queued stale captures must never
            // delay the newest mouse-up or keyboard selection.
            tasks.clear();
            tasks.push_back(std::move(task));
        }
        taskCondition.notify_one();
    }

    void emit(const std::string &json) {
        if (json.empty() || !running.load(std::memory_order_acquire)) {
            return;
        }
        std::lock_guard<std::mutex> lock(callbackMutex);
        if (callback != nullptr && running.load(std::memory_order_acquire)) {
            callback(json.c_str(), callbackContext);
        }
    }

    void workerMain() {
        while (true) {
            Task task;
            {
                std::unique_lock<std::mutex> lock(taskMutex);
                taskCondition.wait(lock, [this] {
                    return !running.load(std::memory_order_acquire) || !tasks.empty();
                });
                if (!running.load(std::memory_order_acquire)) {
                    tasks.clear();
                    return;
                }
                task = std::move(tasks.front());
                tasks.pop_front();
            }

            @autoreleasepool {
                if (task.generation != captureGeneration.load(std::memory_order_acquire)) {
                    continue;
                }

                // Let the target application commit its selection after the
                // input event without ever blocking the event-tap callback.
                std::this_thread::sleep_for(std::chrono::milliseconds(12));
                if (task.generation != captureGeneration.load(std::memory_order_acquire)) {
                    continue;
                }
                const uint64_t captureStartedAt = MonotonicMilliseconds();
                SelectionInfo info;
                bool captured = false;
                {
                    std::lock_guard<std::mutex> captureLock(captureMutex);
                    captured = CaptureSelection(
                        excludedBundleId,
                        task.trigger,
                        task.mouseStart,
                        task.hasMouseStart,
                        task.mouseEnd,
                        task.hasMouseEnd,
                        task.mouseCurrent,
                        info,
                        enhancedUiCache,
                        &captureGeneration,
                        task.generation);
                }
                const uint64_t completedAt = MonotonicMilliseconds();
                TraceSelectionTiming("capture", completedAt - captureStartedAt);
                TraceSelectionTiming(
                    "mouse-up-to-capture-complete",
                    completedAt - task.enqueuedAtMs);
                if (captured && task.generation == captureGeneration.load(std::memory_order_acquire)) {
                    emit(SelectionJSON(info));
                }
            }
        }
    }

    void dismissMain() {
        while (true) {
            Task task;
            {
                std::unique_lock<std::mutex> lock(dismissMutex);
                dismissCondition.wait(lock, [this] {
                    return !running.load(std::memory_order_acquire) || !dismissTasks.empty();
                });
                if (!running.load(std::memory_order_acquire)) {
                    dismissTasks.clear();
                    return;
                }
                task = std::move(dismissTasks.front());
                dismissTasks.pop_front();
            }
            emit(DismissJSON(task));
        }
    }

    void eventMain() {
        @autoreleasepool {
            CFRunLoopRef runLoop = CFRunLoopGetCurrent();
            CGEventMask eventMask =
                CGEventMaskBit(kCGEventLeftMouseDown) |
                CGEventMaskBit(kCGEventLeftMouseUp) |
                CGEventMaskBit(kCGEventRightMouseDown) |
                CGEventMaskBit(kCGEventOtherMouseDown) |
                CGEventMaskBit(kCGEventScrollWheel) |
                CGEventMaskBit(kCGEventKeyDown) |
                CGEventMaskBit(kCGEventKeyUp);

            eventTap = CGEventTapCreate(
                kCGSessionEventTap,
                kCGTailAppendEventTap,
                kCGEventTapOptionListenOnly,
                eventMask,
                &TextLensSelectionMonitor::eventTapCallback,
                this);
            if (eventTap != nullptr) {
                runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0);
            }

            int32_t status = eventTap != nullptr && runLoopSource != nullptr
                ? TEXTLENS_SELECTION_OK
                : TEXTLENS_SELECTION_EVENT_TAP_FAILED;
            if (status == TEXTLENS_SELECTION_OK) {
                {
                    std::lock_guard<std::mutex> lock(runLoopMutex);
                    eventRunLoop = runLoop;
                }
                CFRunLoopAddSource(runLoop, runLoopSource, kCFRunLoopDefaultMode);
                CGEventTapEnable(eventTap, true);

                CFRunLoopTimerContext timerContext = {0, this, nullptr, nullptr, nullptr};
                healthTimer = CFRunLoopTimerCreate(
                    kCFAllocatorDefault,
                    CFAbsoluteTimeGetCurrent() + kEventTapHealthCheckIntervalSeconds,
                    kEventTapHealthCheckIntervalSeconds,
                    0,
                    0,
                    &TextLensSelectionMonitor::HealthCheckTimerCallback,
                    &timerContext);
                if (healthTimer != nullptr) {
                    CFRunLoopAddTimer(runLoop, healthTimer, kCFRunLoopDefaultMode);
                }
            }
            {
                std::lock_guard<std::mutex> lock(startupMutex);
                startupStatus = status;
                startupReady = true;
            }
            startupCondition.notify_all();

            if (status == TEXTLENS_SELECTION_OK && running.load(std::memory_order_acquire)) {
                CFRunLoopRun();
            }

            if (eventTap != nullptr) {
                CGEventTapEnable(eventTap, false);
            }
            if (healthTimer != nullptr) {
                CFRunLoopRemoveTimer(runLoop, healthTimer, kCFRunLoopDefaultMode);
                CFRelease(healthTimer);
                healthTimer = nullptr;
            }
            if (runLoopSource != nullptr) {
                CFRunLoopRemoveSource(runLoop, runLoopSource, kCFRunLoopDefaultMode);
                CFRelease(runLoopSource);
                runLoopSource = nullptr;
            }
            if (eventTap != nullptr) {
                CFRelease(eventTap);
                eventTap = nullptr;
            }
            {
                std::lock_guard<std::mutex> lock(runLoopMutex);
                eventRunLoop = nullptr;
            }
        }
    }

    std::string excludedBundleId;
    TextLensSelectionEventCallback callback = nullptr;
    void *callbackContext = nullptr;
    std::mutex callbackMutex;
    EnhancedUiCache enhancedUiCache;

    std::atomic<bool> running{false};
    std::atomic<uint64_t> captureGeneration{0};
    std::mutex lifecycleMutex;
    std::mutex captureMutex;

    std::thread eventThread;
    std::thread workerThread;
    std::thread dismissThread;
    CFMachPortRef eventTap = nullptr;
    CFRunLoopSourceRef runLoopSource = nullptr;
    CFRunLoopTimerRef healthTimer = nullptr;
    CFRunLoopRef eventRunLoop = nullptr;
    std::mutex runLoopMutex;

    std::mutex startupMutex;
    std::condition_variable startupCondition;
    bool startupReady = false;
    int32_t startupStatus = TEXTLENS_SELECTION_INTERNAL_ERROR;

    std::mutex taskMutex;
    std::condition_variable taskCondition;
    std::deque<Task> tasks;
    std::mutex dismissMutex;
    std::condition_variable dismissCondition;
    std::deque<Task> dismissTasks;

    CGPoint mouseDown = CGPointZero;
    CGPoint lastMouseUp = CGPointZero;
    uint64_t mouseDownTime = 0;
    uint64_t lastMouseUpTime = 0;
    bool lastClickWasValid = false;
    bool keyboardSelectionPending = false;
    CGKeyCode keyboardSelectionKey = 0;
};

extern "C" uint8_t textlens_accessibility_is_trusted(void) {
    return AXIsProcessTrusted() ? 1 : 0;
}

extern "C" uint8_t textlens_accessibility_request(void) {
    @autoreleasepool {
        const void *keys[] = { kAXTrustedCheckOptionPrompt };
        const void *values[] = { kCFBooleanTrue };
        CFDictionaryRef options = CFDictionaryCreate(
            kCFAllocatorDefault,
            keys,
            values,
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks);
        bool trusted = AXIsProcessTrustedWithOptions(options);
        if (options != nullptr) CFRelease(options);
        return trusted ? 1 : 0;
    }
}

extern "C" TextLensSelectionMonitor *textlens_selection_monitor_create(
    const char *excluded_bundle_id_utf8,
    TextLensSelectionEventCallback callback,
    void *context) {
    if (excluded_bundle_id_utf8 == nullptr || callback == nullptr) {
        return nullptr;
    }
    try {
        return new TextLensSelectionMonitor(excluded_bundle_id_utf8, callback, context);
    } catch (...) {
        return nullptr;
    }
}

extern "C" int32_t textlens_selection_monitor_start(TextLensSelectionMonitor *monitor) {
    if (monitor == nullptr) {
        return TEXTLENS_SELECTION_INVALID_ARGUMENT;
    }
    try {
        return monitor->start();
    } catch (...) {
        return TEXTLENS_SELECTION_INTERNAL_ERROR;
    }
}

extern "C" int32_t textlens_selection_monitor_stop(TextLensSelectionMonitor *monitor) {
    if (monitor == nullptr) {
        return TEXTLENS_SELECTION_INVALID_ARGUMENT;
    }
    try {
        return monitor->stop();
    } catch (...) {
        return TEXTLENS_SELECTION_INTERNAL_ERROR;
    }
}

extern "C" char *textlens_selection_monitor_capture_current(
    TextLensSelectionMonitor *monitor,
    int32_t *status_out) {
    if (status_out != nullptr) *status_out = TEXTLENS_SELECTION_INVALID_ARGUMENT;
    if (monitor == nullptr) {
        return nullptr;
    }
    if (!AXIsProcessTrusted()) {
        if (status_out != nullptr) *status_out = TEXTLENS_SELECTION_NOT_TRUSTED;
        return nullptr;
    }
    try {
        SelectionInfo info;
        if (!monitor->captureCurrent(info)) {
            if (status_out != nullptr) *status_out = TEXTLENS_SELECTION_OK;
            return nullptr;
        }
        std::string json = SelectionJSON(info);
        if (json.empty()) {
            if (status_out != nullptr) *status_out = TEXTLENS_SELECTION_INTERNAL_ERROR;
            return nullptr;
        }
        char *result = static_cast<char *>(std::malloc(json.size() + 1));
        if (result == nullptr) {
            if (status_out != nullptr) *status_out = TEXTLENS_SELECTION_INTERNAL_ERROR;
            return nullptr;
        }
        std::memcpy(result, json.data(), json.size());
        result[json.size()] = '\0';
        if (status_out != nullptr) *status_out = TEXTLENS_SELECTION_OK;
        return result;
    } catch (...) {
        if (status_out != nullptr) *status_out = TEXTLENS_SELECTION_INTERNAL_ERROR;
        return nullptr;
    }
}

extern "C" void textlens_selection_string_free(char *value) {
    std::free(value);
}

extern "C" uint8_t textlens_selection_clear_matching_text(
    const char *bundle_id_utf8,
    const char *text_utf8) {
    try {
        if (text_utf8 == nullptr || text_utf8[0] == '\0') {
            return 0;
        }
        std::string expectedText(text_utf8);
        std::string requiredBundleId;
        if (bundle_id_utf8 != nullptr && bundle_id_utf8[0] != '\0') {
            requiredBundleId.assign(bundle_id_utf8);
        }

        __block uint8_t result = 0;
        void (^work)(void) = ^{
            result = ClearMatchingTextOnMainThread(requiredBundleId, expectedText);
        };
        if ([NSThread isMainThread]) {
            work();
        } else {
            // AX write must run on the main thread; hop when called from a worker.
            dispatch_sync(dispatch_get_main_queue(), work);
        }
        return result;
    } catch (...) {
        return 0;
    }
}

extern "C" void textlens_selection_monitor_destroy(TextLensSelectionMonitor *monitor) {
    delete monitor;
}
