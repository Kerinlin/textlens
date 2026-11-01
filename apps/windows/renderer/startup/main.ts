import '../../../../src/renderer/styles.css'
import './startup.css'

export function startupNoticeText(search: string): string {
  return new URLSearchParams(search).get('kind') === 'running'
    ? 'Flick 已在运行'
    : 'Flick 已启动'
}

const root = document.querySelector<HTMLElement>('#root')
if (root) {
  root.innerHTML = `
    <div class="startup-notice" role="status" aria-live="polite">
      <span class="startup-notice__mark" aria-hidden="true">✓</span>
      <span>${startupNoticeText(window.location.search)}</span>
    </div>
  `
  root.classList.add('startup-notice-root--ready')
}
