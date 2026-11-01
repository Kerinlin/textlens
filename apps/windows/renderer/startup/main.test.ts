/// <reference types="node" />

import { readFileSync } from 'node:fs'

import { startupNoticeText } from './main'

const startupCss = readFileSync('apps/windows/renderer/startup/startup.css', 'utf8')

describe('startupNoticeText', () => {
  it('uses a distinct message for ordinary and repeated launches', () => {
    expect(startupNoticeText('?kind=started')).toBe('Flick 已启动')
    expect(startupNoticeText('?kind=running')).toBe('Flick 已在运行')
    expect(startupNoticeText('')).toBe('Flick 已启动')
  })

  it('holds for one second and fades during the final half second', () => {
    expect(startupCss).toMatch(/animation:\s*startup-notice-lifetime\s+1\.5s/)
    expect(startupCss).toContain('66.6667%')
    expect(startupCss).toMatch(/100%\s*\{\s*opacity:\s*0/s)
  })
})
