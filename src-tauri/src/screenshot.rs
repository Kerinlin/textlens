//! Region screenshot capture, annotation flattening, and clipboard images.
//!
//! Capture uses xcap against the physical desktop. The overlay is hidden
//! before the grab so TextLens does not appear in its own screenshot. Text
//! extraction runs as an image-input action through the standard pipeline
//! (see `runtime::run_screenshot_action`).

use std::io::Cursor;

use base64::Engine;
use image::{imageops::overlay, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

pub const MAX_SCREENSHOT_EDGE: u32 = 8_192;
pub const MAX_SCREENSHOT_PNG_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_ANNOTATIONS: usize = 200;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShotPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShotColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShotAnnotation {
    Stroke {
        points: Vec<ShotPoint>,
        color: ShotColor,
        width: f64,
    },
    Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        color: ShotColor,
        stroke_width: f64,
    },
    Arrow {
        from: ShotPoint,
        to: ShotPoint,
        color: ShotColor,
        width: f64,
    },
    Text {
        x: f64,
        y: f64,
        text: String,
        color: ShotColor,
        size: f64,
    },
    Mosaic {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        block: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapturedShot {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

pub fn capture_region(rect: ScreenshotRect) -> Result<CapturedShot, String> {
    validate_rect(rect)?;
    let image = capture_physical_region(rect)?;
    encode_shot(&image)
}

pub fn flatten_annotations(
    png_base64: &str,
    annotations: &[ShotAnnotation],
) -> Result<CapturedShot, String> {
    if annotations.len() > MAX_ANNOTATIONS {
        return Err("标注数量过多".to_owned());
    }
    let mut image = decode_png_base64(png_base64)?;
    for annotation in annotations {
        apply_annotation(&mut image, annotation)?;
    }
    encode_shot(&image)
}

pub fn copy_png_base64(png_base64: &str) -> Result<(), String> {
    let image = decode_png_base64(png_base64)?;
    copy_image(&image)
}

fn validate_rect(rect: ScreenshotRect) -> Result<(), String> {
    if rect.width == 0
        || rect.height == 0
        || rect.width > MAX_SCREENSHOT_EDGE
        || rect.height > MAX_SCREENSHOT_EDGE
    {
        return Err("截图区域无效".to_owned());
    }
    Ok(())
}

fn capture_physical_region(rect: ScreenshotRect) -> Result<RgbaImage, String> {
    // `rect` is in global physical pixels with a top-left origin (y grows
    // downward), matching Tauri's `outer_position`. xcap reports each
    // monitor's frame in CG points with a bottom-left origin (y grows upward
    // from the primary display's top edge) while its captured bitmaps are
    // physical pixels. Convert every frame into AppKit-style physical pixels
    // so the intersection below stays in a single coordinate space.
    let monitors = xcap::Monitor::all().map_err(|_| "无法读取显示器".to_owned())?;
    let main_height = monitors
        .iter()
        .filter(|monitor| monitor.is_primary().unwrap_or(false))
        .find_map(|monitor| monitor.height().ok())
        .unwrap_or(0) as i32;
    let mut canvas = RgbaImage::from_pixel(rect.width, rect.height, Rgba([0, 0, 0, 255]));
    let mut covered = false;
    let rect_right = rect.x.saturating_add(rect.width as i32);
    let rect_bottom = rect.y.saturating_add(rect.height as i32);
    for monitor in &monitors {
        let origin_x = monitor.x().map_err(|_| "无法读取显示器位置".to_owned())?;
        let origin_y = monitor.y().map_err(|_| "无法读取显示器位置".to_owned())?;
        let width = monitor.width().map_err(|_| "无法读取显示器尺寸".to_owned())?;
        let height = monitor.height().map_err(|_| "无法读取显示器尺寸".to_owned())?;
        let scale = f64::from(
            monitor
                .scale_factor()
                .map_err(|_| "无法读取显示器缩放".to_owned())?,
        );
        let frame_top = main_height.saturating_sub(origin_y.saturating_add(height as i32));
        let frame_x = (f64::from(origin_x) * scale).round() as i32;
        let frame_y = (f64::from(frame_top) * scale).round() as i32;
        let frame_right = frame_x.saturating_add((f64::from(width) * scale).round() as i32);
        let frame_bottom = frame_y.saturating_add((f64::from(height) * scale).round() as i32);
        let left = rect.x.max(frame_x);
        let top = rect.y.max(frame_y);
        let right = rect_right.min(frame_right);
        let bottom = rect_bottom.min(frame_bottom);
        if left >= right || top >= bottom {
            continue;
        }
        let grabbed = monitor
            .capture_image()
            .map_err(|_| "截取屏幕失败，请检查屏幕录制权限".to_owned())?;
        let crop_x = (left - frame_x).max(0) as u32;
        let crop_y = (top - frame_y).max(0) as u32;
        let crop_width = (right - left) as u32;
        let crop_height = (bottom - top) as u32;
        if crop_x.saturating_add(crop_width) > grabbed.width()
            || crop_y.saturating_add(crop_height) > grabbed.height()
        {
            return Err("截图区域超出了显示器画面".to_owned());
        }
        let cropped = image::imageops::crop_imm(&grabbed, crop_x, crop_y, crop_width, crop_height);
        overlay(
            &mut canvas,
            &*cropped,
            i64::from(left - rect.x),
            i64::from(top - rect.y),
        );
        covered = true;
    }
    if !covered {
        return Err("截图区域不在任何显示器上".to_owned());
    }
    Ok(canvas)
}

fn encode_shot(image: &RgbaImage) -> Result<CapturedShot, String> {
    let (width, height) = image.dimensions();
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|_| "无法编码截图".to_owned())?;
    if png.len() > MAX_SCREENSHOT_PNG_BYTES {
        return Err("截图过大".to_owned());
    }
    Ok(CapturedShot {
        png_base64: base64::engine::general_purpose::STANDARD.encode(png),
        width,
        height,
    })
}

fn decode_png_base64(value: &str) -> Result<RgbaImage, String> {
    if value.len() > MAX_SCREENSHOT_PNG_BYTES.saturating_mul(2) {
        return Err("截图数据过大".to_owned());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| "截图数据无效".to_owned())?;
    if bytes.len() > MAX_SCREENSHOT_PNG_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("截图数据无效".to_owned());
    }
    let image = image::load_from_memory(&bytes)
        .map_err(|_| "无法读取截图".to_owned())?
        .into_rgba8();
    let (width, height) = image.dimensions();
    if width == 0
        || height == 0
        || width > MAX_SCREENSHOT_EDGE
        || height > MAX_SCREENSHOT_EDGE
    {
        return Err("截图尺寸无效".to_owned());
    }
    Ok(image)
}

fn apply_annotation(image: &mut RgbaImage, annotation: &ShotAnnotation) -> Result<(), String> {
    match annotation {
        ShotAnnotation::Stroke { points, color, width } => {
            if points.len() < 2 || !(0.5..=64.0).contains(width) {
                return Err("画笔标注无效".to_owned());
            }
            let radius = (*width / 2.0).clamp(0.5, 32.0);
            for pair in points.windows(2) {
                stroke_line(image, pair[0], pair[1], color.rgba(), radius);
            }
        }
        ShotAnnotation::Rect { x, y, width, height, color, stroke_width } => {
            if !(0.5..=64.0).contains(stroke_width) {
                return Err("矩形标注无效".to_owned());
            }
            stroke_rect(image, *x, *y, *width, *height, color.rgba(), *stroke_width);
        }
        ShotAnnotation::Arrow { from, to, color, width } => {
            if !(0.5..=64.0).contains(width) {
                return Err("箭头标注无效".to_owned());
            }
            stroke_line(image, *from, *to, color.rgba(), width / 2.0);
            stroke_arrow_head(image, *from, *to, color.rgba(), *width);
        }
        ShotAnnotation::Text { x, y, text, color, size } => {
            let text = text.trim();
            if text.is_empty() || text.chars().count() > 200 || !(8.0..=96.0).contains(size) {
                return Err("文字标注无效".to_owned());
            }
            draw_bitmap_text(image, *x, *y, text, color.rgba(), *size);
        }
        ShotAnnotation::Mosaic { x, y, width, height, block } => {
            let block = (*block).clamp(4, 64);
            pixelate(image, *x, *y, *width, *height, block);
        }
    }
    Ok(())
}

impl ShotColor {
    fn rgba(self) -> Rgba<u8> {
        Rgba([self.r, self.g, self.b, self.a])
    }
}

fn stroke_line(image: &mut RgbaImage, from: ShotPoint, to: ShotPoint, color: Rgba<u8>, radius: f64) {
    let (width, height) = image.dimensions();
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let steps = dx.abs().max(dy.abs()).ceil().max(1.0) as i32;
    for step in 0..=steps {
        let t = f64::from(step) / f64::from(steps);
        stamp(
            image,
            width,
            height,
            from.x + dx * t,
            from.y + dy * t,
            radius,
            color,
        );
    }
}

fn stroke_rect(
    image: &mut RgbaImage,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color: Rgba<u8>,
    stroke: f64,
) {
    let right = x + width;
    let bottom = y + height;
    let radius = stroke / 2.0;
    stroke_line(image, ShotPoint { x, y }, ShotPoint { x: right, y }, color, radius);
    stroke_line(image, ShotPoint { x: right, y }, ShotPoint { x: right, y: bottom }, color, radius);
    stroke_line(image, ShotPoint { x: right, y: bottom }, ShotPoint { x, y: bottom }, color, radius);
    stroke_line(image, ShotPoint { x, y: bottom }, ShotPoint { x, y }, color, radius);
}

fn stroke_arrow_head(
    image: &mut RgbaImage,
    from: ShotPoint,
    to: ShotPoint,
    color: Rgba<u8>,
    width: f64,
) {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let length = dx.hypot(dy).max(1.0);
    let ux = dx / length;
    let uy = dy / length;
    let head = (width * 4.0).clamp(10.0, 36.0);
    let left = ShotPoint {
        x: to.x - ux * head - uy * head * 0.45,
        y: to.y - uy * head + ux * head * 0.45,
    };
    let right = ShotPoint {
        x: to.x - ux * head + uy * head * 0.45,
        y: to.y - uy * head - ux * head * 0.45,
    };
    stroke_line(image, to, left, color, width / 2.0);
    stroke_line(image, to, right, color, width / 2.0);
}

fn stamp(
    image: &mut RgbaImage,
    width: u32,
    height: u32,
    x: f64,
    y: f64,
    radius: f64,
    color: Rgba<u8>,
) {
    let min_x = (x - radius).floor().max(0.0) as u32;
    let max_x = (x + radius).ceil().min(f64::from(width.saturating_sub(1))) as u32;
    let min_y = (y - radius).floor().max(0.0) as u32;
    let max_y = (y + radius).ceil().min(f64::from(height.saturating_sub(1))) as u32;
    for py in min_y..=max_y {
        for px in min_x..=max_x {
            let distance = (f64::from(px) - x).hypot(f64::from(py) - y);
            if distance <= radius + 0.35 {
                image.put_pixel(px, py, color);
            }
        }
    }
}

fn pixelate(image: &mut RgbaImage, x: f64, y: f64, width: f64, height: f64, block: u32) {
    let (image_width, image_height) = image.dimensions();
    let left = x.floor().max(0.0) as u32;
    let top = y.floor().max(0.0) as u32;
    let right = (x + width).ceil().min(f64::from(image_width)) as u32;
    let bottom = (y + height).ceil().min(f64::from(image_height)) as u32;
    let mut y0 = top;
    while y0 < bottom {
        let y1 = (y0 + block).min(bottom);
        let mut x0 = left;
        while x0 < right {
            let x1 = (x0 + block).min(right);
            let mut red = 0u64;
            let mut green = 0u64;
            let mut blue = 0u64;
            let mut count = 0u64;
            for py in y0..y1 {
                for px in x0..x1 {
                    let pixel = image.get_pixel(px, py).0;
                    red += u64::from(pixel[0]);
                    green += u64::from(pixel[1]);
                    blue += u64::from(pixel[2]);
                    count += 1;
                }
            }
            if count > 0 {
                let color = Rgba([
                    (red / count) as u8,
                    (green / count) as u8,
                    (blue / count) as u8,
                    255,
                ]);
                for py in y0..y1 {
                    for px in x0..x1 {
                        image.put_pixel(px, py, color);
                    }
                }
            }
            x0 = x1;
        }
        y0 = y1;
    }
}

const GLYPHS: &[(char, u32)] = &[
    ('0', 0b011_101_101_101_101_101_011),
    ('1', 0b010_110_010_010_010_010_111),
    ('2', 0b111_001_001_111_100_100_111),
    ('3', 0b111_001_001_111_001_001_111),
    ('4', 0b101_101_101_111_001_001_001),
    ('5', 0b111_100_100_111_001_001_111),
    ('6', 0b011_100_100_111_101_101_111),
    ('7', 0b111_001_001_010_010_100_100),
    ('8', 0b111_101_101_111_101_101_111),
    ('9', 0b111_101_101_111_001_001_110),
    ('A', 0b010_101_101_111_101_101_101),
    ('B', 0b110_101_101_110_101_101_110),
    ('C', 0b011_100_100_100_100_100_011),
    ('D', 0b110_101_101_101_101_101_110),
    ('E', 0b111_100_100_110_100_100_111),
    ('F', 0b111_100_100_110_100_100_100),
    ('G', 0b011_100_100_101_101_101_011),
    ('H', 0b101_101_101_111_101_101_101),
    ('I', 0b111_010_010_010_010_010_111),
    ('J', 0b001_001_001_001_101_101_010),
    ('K', 0b101_101_110_100_110_101_101),
    ('L', 0b100_100_100_100_100_100_111),
    ('M', 0b101_111_111_101_101_101_101),
    ('N', 0b101_111_111_111_101_101_101),
    ('O', 0b010_101_101_101_101_101_010),
    ('P', 0b110_101_101_110_100_100_100),
    ('Q', 0b010_101_101_101_101_010_001),
    ('R', 0b110_101_101_110_101_101_101),
    ('S', 0b011_100_100_010_001_001_110),
    ('T', 0b111_010_010_010_010_010_010),
    ('U', 0b101_101_101_101_101_101_011),
    ('V', 0b101_101_101_101_101_010_010),
    ('W', 0b101_101_101_101_111_111_101),
    ('X', 0b101_101_010_010_010_101_101),
    ('Y', 0b101_101_010_010_010_010_010),
    ('Z', 0b111_001_001_010_100_100_111),
    (' ', 0),
    ('-', 0b000_000_000_111_000_000_000),
    ('.', 0b000_000_000_000_000_010_010),
    (':', 0b000_010_010_000_010_010_000),
    ('/', 0b001_001_010_010_010_100_100),
];

fn glyph(character: char) -> u32 {
    let upper = character.to_ascii_uppercase();
    GLYPHS
        .iter()
        .find(|(candidate, _)| *candidate == upper)
        .map(|(_, bits)| *bits)
        .unwrap_or(0b101_010_101_010_101_010_101)
}

fn draw_bitmap_text(
    image: &mut RgbaImage,
    x: f64,
    y: f64,
    text: &str,
    color: Rgba<u8>,
    size: f64,
) {
    let scale = (size / 8.0).clamp(1.0, 8.0).round() as i32;
    let mut cursor = x.round() as i32;
    let top = y.round() as i32;
    for character in text.chars().take(200) {
        let bits = glyph(character);
        for row in 0..7 {
            let row_bits = (bits >> (18 - row * 3)) & 0b111;
            for col in 0..3 {
                if (row_bits >> (2 - col)) & 1 == 1 {
                    fill_rect(
                        image,
                        cursor + col * scale,
                        top + row * scale,
                        scale,
                        scale,
                        color,
                    );
                }
            }
        }
        cursor += 4 * scale;
    }
}

fn fill_rect(image: &mut RgbaImage, x: i32, y: i32, width: i32, height: i32, color: Rgba<u8>) {
    let (image_width, image_height) = image.dimensions();
    for py in y..y + height {
        for px in x..x + width {
            if px >= 0 && py >= 0 && (px as u32) < image_width && (py as u32) < image_height {
                image.put_pixel(px as u32, py as u32, color);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn copy_image(image: &RgbaImage) -> Result<(), String> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSImage, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    use objc2_foundation::NSData;

    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|_| "无法编码剪贴板图片".to_owned())?;
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let png_data = NSData::with_bytes(&png);
    // SAFETY: both type globals are AppKit-provided immutable globals.
    let png_type = unsafe { NSPasteboardTypePNG };
    pasteboard
        .setData_forType(Some(&png_data), png_type)
        .then_some(())
        .ok_or_else(|| "无法写入系统剪贴板".to_owned())?;
    // Many macOS apps only paste images advertised as TIFF; publish both
    // flavors so image paste works across common targets.
    if let Some(tiff) = NSImage::initWithData(NSImage::alloc(), &png_data)
        .and_then(|decoded| decoded.TIFFRepresentation())
    {
        let tiff_type = unsafe { NSPasteboardTypeTIFF };
        let _ = pasteboard.setData_forType(Some(&tiff), tiff_type);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_image(image: &RgbaImage) -> Result<(), String> {
    use std::{mem::size_of, ptr, thread, time::Duration};

    use windows::{
        core::{w, Free},
        Win32::{
            Foundation::{GetLastError, HANDLE, HGLOBAL, HWND, WIN32_ERROR},
            Graphics::Gdi::BITMAPINFOHEADER,
            System::{
                DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
                Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            },
            UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WINDOW_STYLE,
            },
        },
    };

    const CF_DIB: u32 = 8;

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }
    struct ClipboardOwnerWindow(HWND);
    impl Drop for ClipboardOwnerWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }
    struct OwnedGlobalMemory(Option<HGLOBAL>);
    impl OwnedGlobalMemory {
        fn relinquish(&mut self) {
            self.0 = None;
        }
    }
    impl Drop for OwnedGlobalMemory {
        fn drop(&mut self) {
            if let Some(mut handle) = self.0.take() {
                unsafe { handle.free() };
            }
        }
    }

    let dib = encode_windows_dib(image)?;
    let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, dib.len()) }
        .map_err(|_| "无法分配剪贴板图片".to_owned())?;
    let mut memory = OwnedGlobalMemory(Some(global));
    let destination = unsafe { GlobalLock(global) };
    if destination.is_null() {
        return Err("无法锁定剪贴板图片".to_owned());
    }
    unsafe { ptr::copy_nonoverlapping(dib.as_ptr(), destination.cast(), dib.len()) };
    unsafe { windows::Win32::Foundation::SetLastError(WIN32_ERROR(0)) };
    if unsafe { GlobalUnlock(global) }.is_err() {
        let error = unsafe { GetLastError() };
        if error.0 != 0 {
            return Err("无法解锁剪贴板图片".to_owned());
        }
    }

    let owner = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("Flick Clipboard Owner"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        )
    }
    .map(ClipboardOwnerWindow)
    .map_err(|_| "无法创建剪贴板所有者窗口".to_owned())?;
    let mut opened = false;
    for attempt in 0..8 {
        if unsafe { OpenClipboard(Some(owner.0)) }.is_ok() {
            opened = true;
            break;
        }
        thread::sleep(Duration::from_millis(4 * (attempt + 1)));
    }
    if !opened {
        return Err("系统剪贴板正忙".to_owned());
    }
    let _clipboard = ClipboardGuard;
    unsafe { EmptyClipboard() }.map_err(|_| "无法清空系统剪贴板".to_owned())?;
    unsafe { SetClipboardData(CF_DIB, Some(HANDLE(global.0))) }
        .map_err(|_| "无法写入系统剪贴板".to_owned())?;
    memory.relinquish();
    Ok(())
}

#[cfg(target_os = "windows")]
fn encode_windows_dib(image: &RgbaImage) -> Result<Vec<u8>, String> {
    use std::mem::size_of;

    use windows::Win32::Graphics::Gdi::BITMAPINFOHEADER;

    let (width, height) = image.dimensions();
    let header_size = size_of::<BITMAPINFOHEADER>();
    let row_stride = (width as usize).saturating_mul(4);
    let total = header_size
        .checked_add(row_stride.saturating_mul(height as usize))
        .ok_or_else(|| "截图过大，无法复制".to_owned())?;
    let mut dib = vec![0u8; total];
    let header = BITMAPINFOHEADER {
        biSize: header_size as u32,
        biWidth: width as i32,
        biHeight: height as i32,
        biPlanes: 1,
        biBitCount: 32,
        ..Default::default()
    };
    dib[..header_size].copy_from_slice(unsafe {
        std::slice::from_raw_parts((&raw const header).cast::<u8>(), header_size)
    });
    for y in 0..height {
        let target_y = height - 1 - y;
        for x in 0..width {
            let pixel = image.get_pixel(x, y).0;
            let offset = header_size + (target_y as usize) * row_stride + (x as usize) * 4;
            dib[offset] = pixel[2];
            dib[offset + 1] = pixel[1];
            dib[offset + 2] = pixel[0];
            dib[offset + 3] = pixel[3];
        }
    }
    Ok(dib)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn copy_image(_image: &RgbaImage) -> Result<(), String> {
    Err("当前平台不支持复制图片".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_a_rect_into_the_png() {
        let image = RgbaImage::from_pixel(40, 30, Rgba([255, 255, 255, 255]));
        let shot = encode_shot(&image).unwrap();
        let flattened = flatten_annotations(
            &shot.png_base64,
            &[ShotAnnotation::Rect {
                x: 4.0,
                y: 4.0,
                width: 20.0,
                height: 12.0,
                color: ShotColor { r: 255, g: 0, b: 0, a: 255 },
                stroke_width: 2.0,
            }],
        )
        .unwrap();
        let result = decode_png_base64(&flattened.png_base64).unwrap();
        assert_eq!(result.get_pixel(4, 4).0[0], 255);
        assert_eq!(result.get_pixel(4, 4).0[1], 0);
    }

    #[test]
    fn rejects_an_empty_region() {
        assert!(capture_region(ScreenshotRect { x: 0, y: 0, width: 0, height: 10 }).is_err());
    }
}
