#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: collect-page.sh <task-space-id> <page-no> <staging-root> [reuse-candidate-root] [profile-min-seconds] [bulk-min-seconds]" >&2
  exit 2
fi

if [[ ! "$1" =~ ^[0-9]+$ || ! "$2" =~ ^[0-9]+$ ]]; then
  echo "Task-space ID and page number must be integers" >&2
  exit 2
fi

BAYT_PROFILE_MIN_SECONDS="${5:-20}"
BAYT_BULK_MIN_SECONDS="${6:-120}"
if [[ ! "$BAYT_PROFILE_MIN_SECONDS" =~ ^[0-9]+$ || ! "$BAYT_BULK_MIN_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Minimum intervals must be non-negative integers" >&2
  exit 2
fi

BAYT_PAGE_CONFIG_PATH="/tmp/bayt-collector-collect-page-config.json"
node --input-type=module -e '
  import * as fs from "node:fs/promises";
  const [filePath, taskSpaceId, pageNo, stagingRoot, reuseRoot, profileMinSeconds, bulkMinSeconds] = process.argv.slice(1);
  await fs.writeFile(filePath, JSON.stringify({ taskSpaceId, pageNo, stagingRoot, reuseRoot, profileMinSeconds, bulkMinSeconds }), { mode: 0o600 });
' "$BAYT_PAGE_CONFIG_PATH" "$1" "$2" "$3" "${4:-}" "$BAYT_PROFILE_MIN_SECONDS" "$BAYT_BULK_MIN_SECONDS"

ego-browser nodejs <<'EOF'
const fs = await import('node:fs/promises')
const path = await import('node:path')
const crypto = await import('node:crypto')

const runtimeConfig = JSON.parse(
  await fs.readFile('/tmp/bayt-collector-collect-page-config.json', 'utf8'),
)
const taskSpaceId = Number.parseInt(runtimeConfig.taskSpaceId || '', 10)
const pageNo = Number.parseInt(runtimeConfig.pageNo || '', 10)
const profileMinSeconds = Number.parseInt(runtimeConfig.profileMinSeconds || '20', 10)
const bulkMinSeconds = Number.parseInt(runtimeConfig.bulkMinSeconds || '120', 10)
const stagingRoot = path.resolve(runtimeConfig.stagingRoot || '')
const reuseRoot = runtimeConfig.reuseRoot
  ? path.resolve(runtimeConfig.reuseRoot)
  : null
if (
  !Number.isInteger(taskSpaceId) ||
  !Number.isInteger(pageNo) ||
  pageNo < 1 ||
  !Number.isInteger(profileMinSeconds) ||
  profileMinSeconds < 0 ||
  !Number.isInteger(bulkMinSeconds) ||
  bulkMinSeconds < 0 ||
  !stagingRoot
) {
  throw new Error('Invalid collect-page arguments')
}

const batchRoot = path.join(stagingRoot, 'batches', String(pageNo).padStart(4, '0'))
const downloadsDir = path.join(batchRoot, 'downloads')
const candidateRoot = path.join(batchRoot, 'candidates')
await fs.mkdir(downloadsDir, { recursive: true, mode: 0o700 })
await fs.mkdir(candidateRoot, { recursive: true, mode: 0o700 })

const writeJsonAtomic = async (filePath, value) => {
  const temporary = `${filePath}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fs.rename(temporary, filePath)
}

const readJson = async (filePath, fallback = {}) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

const runtimeStatePath = path.join(stagingRoot, 'runtime-state.json')
const throttleStatePath = path.join(stagingRoot, 'throttle-state.json')
const backoffScheduleSeconds = [300, 900, 3600]

const recordRateLimit = async (reason) => {
  const previous = await readJson(runtimeStatePath)
  const rateLimitCount = Number(previous.rate_limit_count || 0) + 1
  const backoffSeconds = backoffScheduleSeconds[
    Math.min(rateLimitCount - 1, backoffScheduleSeconds.length - 1)
  ]
  const detectedAt = new Date()
  const nextAttemptAt = new Date(detectedAt.getTime() + backoffSeconds * 1000)
  await writeJsonAtomic(runtimeStatePath, {
    status: 'rate_limited',
    reason,
    page_no: pageNo,
    rate_limit_count: rateLimitCount,
    backoff_seconds: backoffSeconds,
    detected_at: detectedAt.toISOString(),
    next_attempt_at: nextAttemptAt.toISOString(),
    resume_policy: 'manual_confirmation_required',
  })
}

const assertBackoffElapsed = async () => {
  const state = await readJson(runtimeStatePath)
  if (state.status !== 'rate_limited' || !state.next_attempt_at) return
  const remainingMs = Date.parse(state.next_attempt_at) - Date.now()
  if (remainingMs > 0) {
    throw new Error(
      `RATE_LIMIT_BACKOFF: wait ${Math.ceil(remainingMs / 1000)} more seconds and require manual continue`,
    )
  }
}

const enforceMinimumInterval = async (kind, minimumSeconds) => {
  if (minimumSeconds <= 0) return
  const state = await readJson(throttleStatePath)
  const key = `${kind}_last_started_at`
  const lastStarted = Date.parse(state[key] || '')
  if (Number.isFinite(lastStarted)) {
    let remainingMs = minimumSeconds * 1000 - (Date.now() - lastStarted)
    while (remainingMs > 0) {
      await wait(Math.min(30, remainingMs / 1000))
      remainingMs = minimumSeconds * 1000 - (Date.now() - lastStarted)
    }
  }
  state[key] = new Date().toISOString()
  state[`${kind}_minimum_seconds`] = minimumSeconds
  await writeJsonAtomic(throttleStatePath, state)
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const safeBody = async () => {
  const state = await js(String.raw`(() => {
    const body = document.body?.innerText || ''
    const dialogText = [...document.querySelectorAll('[role="dialog"], dialog, .modal')]
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      })
      .map((element) => element.innerText || '')
      .join('\n')
    return {
      body,
      title: document.title || '',
      url: location.href,
      dialogText,
      hasCvContext: /Ref:\s*CV\d+/i.test(body) || /CVs matching your search/i.test(body),
    }
  })()`)
  const head = state.body.slice(0, 2500).toLowerCase()
  const securityContext = `${state.title}\n${state.url}\n${head}`.toLowerCase()
  if (/unusually high search activity|please try again in a few minutes/.test(head)) {
    const reason = 'Bayt reported unusually high search activity for the account'
    await recordRateLimit(reason)
    throw new Error(`RATE_LIMITED: ${reason}`)
  }
  if (!state.hasCvContext && /cloudflare|just a moment|verify you are human|captcha|challenge-platform/.test(securityContext)) {
    throw new Error('SAFETY_STOP: anti-bot or verification page detected')
  }
  if (/buy credits|upgrade your plan|purchase required|confirm purchase/i.test(state.dialogText)) {
    throw new Error('SAFETY_STOP: purchase or upgrade page detected')
  }
  if (!state.hasCvContext && /sign in to continue|log in to continue|login required/.test(head)) {
    throw new Error('SAFETY_STOP: login is no longer valid')
  }
  return state.body
}

const extensionFor = (mimeType, originalName = '') => {
  const fromName = path.extname(originalName).toLowerCase()
  if (fromName) return fromName
  const mime = (mimeType || '').toLowerCase()
  if (mime.includes('pdf')) return '.pdf'
  if (mime.includes('wordprocessingml')) return '.docx'
  if (mime.includes('msword')) return '.doc'
  if (mime.includes('rtf')) return '.rtf'
  if (mime.includes('jpeg')) return '.jpg'
  if (mime.includes('png')) return '.png'
  if (mime.includes('webp')) return '.webp'
  return '.bin'
}

const dispositionName = (value) => {
  if (!value) return ''
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (encoded) {
    try { return decodeURIComponent(encoded[1]) } catch { return encoded[1] }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1] || ''
}

await assertBackoffElapsed()
await useOrCreateTaskSpace(taskSpaceId)
cliLog(`stage=task-space page=${pageNo}`)
let tabs = await listTabs()
const listingTab = tabs.find((tab) => String(tab.url || '').includes('/employers/cv-search/listing/'))
if (!listingTab) throw new Error('Bayt CV Search listing tab was not found')
await switchTab(listingTab.targetId)

const currentPage = Number.parseInt(
  String(await js(`document.querySelector('input[name="p"]')?.value || '0'`)),
  10,
)
const currentCount = Number(await js(String.raw`[...document.querySelectorAll('input[type="checkbox"][name]')].filter(x => /^\d+$/.test(x.name)).length`))
if (currentPage !== pageNo || currentCount === 0) {
  await fillInput('input[name="p"]', String(pageNo))
  await pressKey('ENTER')
  let ready = false
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await wait(1)
    await safeBody()
    const state = await js(String.raw`(() => ({
      page: Number.parseInt(document.querySelector('input[name="p"]')?.value || '0', 10),
      count: [...document.querySelectorAll('input[type="checkbox"][name]')].filter(x => /^\d+$/.test(x.name)).length,
    }))()`)
    if (state.page === pageNo && state.count > 0) {
      ready = true
      break
    }
  }
  if (!ready) throw new Error(`Page ${pageNo} did not finish loading`)
}
await safeBody()
const previousRuntimeState = await readJson(runtimeStatePath)
await writeJsonAtomic(runtimeStatePath, {
  ...previousRuntimeState,
  status: 'running',
  page_no: pageNo,
  profile_minimum_seconds: profileMinSeconds,
  bulk_minimum_seconds: bulkMinSeconds,
  updated_at: new Date().toISOString(),
})
cliLog(`stage=listing-ready page=${pageNo}`)

const candidates = await js(String.raw`(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"][name]')]
    .filter((box) => /^\d+$/.test(box.name))
  const result = []
  for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index]
      const item = box.closest('li')
      const link = [...(item?.querySelectorAll('a[href*="/employers/cv-search/profile/"]') || [])]
        .find((anchor) => (anchor.textContent || '').trim())
      const avatarUrl = [...(item?.querySelectorAll('img') || [])]
        .map((image) => image.currentSrc || image.src)
        .find((url) => /user_photos|no-photo/i.test(url || '')) || null
      const updateTitle = [...(item?.querySelectorAll('[title]') || [])]
        .map((element) => element.getAttribute('title'))
        .find((title) => /Last CV update date/i.test(title || ''))
      result.push({
        position: index + 1,
        cv_id: box.name,
        name: (link?.innerText || '').trim().replace(/\s+/g, ' '),
        profile_url: link?.href || null,
        last_updated: updateTitle?.split(':').slice(1).join(':').trim() || null,
        avatar_url: avatarUrl,
        avatar_status: /no-photo/i.test(avatarUrl || '') ? 'placeholder' : avatarUrl ? 'photo' : 'missing',
      })
  }
  return result
})()`)
if (candidates.length !== 50) {
  throw new Error(`Expected 50 candidates on page ${pageNo}, found ${candidates.length}`)
}
if (new Set(candidates.map((candidate) => candidate.cv_id)).size !== candidates.length) {
  throw new Error(`Page ${pageNo} contains duplicate CV_ID values`)
}
if (candidates.some((candidate) => !candidate.profile_url)) {
  throw new Error(`Page ${pageNo} contains a candidate without a profile URL`)
}
await writeJsonAtomic(path.join(batchRoot, 'candidates.json'), candidates)
cliLog(`stage=metadata page=${pageNo} count=${candidates.length}`)

const selectedCount = async () => Number(await js(String.raw`
  [...document.querySelectorAll('input[type="checkbox"][name]:checked')]
    .filter((box) => /^\d+$/.test(box.name)).length
`))

const selectAll = async () => {
  if (await selectedCount() === candidates.length) return
  const masterClicked = await js(String.raw`(() => {
    const text = [...document.querySelectorAll('body *')]
      .find((element) => element.children.length === 0 && element.textContent?.trim() === 'Select all')
    const container = text?.parentElement
    const checkbox = container?.querySelector('input[type="checkbox"]')
    if (!checkbox) return false
    checkbox.click()
    return true
  })()`)
  await wait(1)
  if (!masterClicked || await selectedCount() !== candidates.length) {
    await js(String.raw`(() => {
      for (const checkbox of [...document.querySelectorAll('input[type="checkbox"][name]')]
        .filter((box) => /^\d+$/.test(box.name))) {
        if (!checkbox.checked) checkbox.click()
      }
    })()`)
    await wait(1)
  }
  const count = await selectedCount()
  if (count !== candidates.length) throw new Error(`Select all chose ${count}, expected ${candidates.length}`)
}

const existingDownload = async (extension) => {
  const names = await fs.readdir(downloadsDir)
  return names.find((name) => name.toLowerCase().endsWith(extension)) || null
}

const downloadFormat = async (format, extension) => {
  const existing = await existingDownload(extension)
  if (existing) return path.join(downloadsDir, existing)
  await switchTab(listingTab.targetId)
  await safeBody()
  await enforceMinimumInterval('bulk', bulkMinSeconds)
  await selectAll()
  await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir })
  const opened = await js(String.raw`(() => {
    const action = [...document.querySelectorAll('a')]
      .find((anchor) => anchor.innerText.trim() === 'Download CV')
    if (!action) return false
    action.click()
    return true
  })()`)
  if (!opened) throw new Error('Bulk Download CV action was not found')
  await wait(0.7)
  const selected = await js(`(() => {
    const input = document.querySelector('input[type="radio"][value="${format}"]')
    if (!input) return false
    input.click()
    return input.checked
  })()`)
  if (!selected) throw new Error(`Could not select bulk format ${format}`)
  const clicked = await js(String.raw`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.innerText.trim() === 'Download without revealing')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error('Safe bulk download button was not found')
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(1)
    await safeBody()
    const complete = await existingDownload(extension)
    const partial = (await fs.readdir(downloadsDir)).some((name) => name.endsWith('.crdownload'))
    if (complete && !partial) return path.join(downloadsDir, complete)
  }
  throw new Error(`Bulk ${format} download did not complete`)
}

const standardArchive = await downloadFormat('pdf', '.zip')
const excelExport = await downloadFormat('excel', '.xls')
cliLog(`page=${pageNo} bulk=${JSON.stringify({ standardArchive, excelExport })}`)

const copyExistingCandidate = async (candidate, destination) => {
  if (!reuseRoot) return false
  const source = path.join(reuseRoot, candidate.cv_id)
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'))
    if (String(manifest?.candidate?.cv_id || '') !== candidate.cv_id) return false
    const names = await fs.readdir(source)
    const required = ['profile.json', 'bayt-cv.pdf']
    if (!required.every((name) => names.includes(name))) return false
    for (const name of names) {
      if (!/^(profile\.json|avatar\.|original\.)/.test(name)) continue
      await fs.copyFile(path.join(source, name), path.join(destination, name))
      await fs.chmod(path.join(destination, name), 0o600)
    }
    if (!(await fs.readdir(destination)).some((name) => name.startsWith('original.'))) return false
    await writeJsonAtomic(path.join(destination, 'result.json'), {
      cv_id: candidate.cv_id,
      status: 'complete',
      reused: true,
      completed_at: new Date().toISOString(),
    })
    return true
  } catch {
    return false
  }
}

tabs = await listTabs()
let profileTab = tabs.find((tab) => String(tab.url || '').includes('/employers/cv-search/profile'))
if (!profileTab) profileTab = await openOrReuseTab(candidates[0].profile_url, { wait: true, timeout: 20 })

const collectCandidate = async (candidate) => {
  const destination = path.join(candidateRoot, candidate.cv_id)
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  try {
    const checkpoint = JSON.parse(await fs.readFile(path.join(destination, 'result.json'), 'utf8'))
    if (checkpoint.status === 'complete') return { ...checkpoint, skipped: true }
  } catch {}
  if (await copyExistingCandidate(candidate, destination)) {
    return { cv_id: candidate.cv_id, status: 'complete', reused: true }
  }

  const result = {
    cv_id: candidate.cv_id,
    status: 'running',
    attempts: 0,
    avatar: { status: candidate.avatar_status },
    profile: { status: 'pending' },
    original: { status: 'pending' },
  }
  await writeJsonAtomic(path.join(destination, 'result.json'), result)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result.attempts = attempt
    try {
      if (candidate.avatar_status === 'photo' && candidate.avatar_url && result.avatar.status !== 'downloaded') {
        const response = await fetch(candidate.avatar_url)
        const buffer = Buffer.from(await response.arrayBuffer())
        if (!response.ok || buffer.length < 500) throw new Error(`avatar response ${response.status}`)
        const mimeType = response.headers.get('content-type') || ''
        const avatarPath = path.join(
          destination,
          `avatar${extensionFor(mimeType, new URL(candidate.avatar_url).pathname)}`,
        )
        await fs.writeFile(avatarPath, buffer, { mode: 0o600 })
        result.avatar = {
          status: 'downloaded',
          path: avatarPath,
          mime_type: mimeType,
          size_bytes: buffer.length,
          sha256: sha256(buffer),
        }
      }

      await switchTab(profileTab.targetId)
      await enforceMinimumInterval('profile', profileMinSeconds)
      await gotoAndWait(candidate.profile_url, { timeout: 20, settle: 1 })
      let body = ''
      for (let waitAttempt = 0; waitAttempt < 15; waitAttempt += 1) {
        await wait(1)
        body = await safeBody()
        if (new RegExp(`Ref:\\s*CV${candidate.cv_id}\\b`, 'i').test(body)) break
      }
      if (!new RegExp(`Ref:\\s*CV${candidate.cv_id}\\b`, 'i').test(body)) {
        throw new Error('profile CV_ID mismatch')
      }
      const profile = {
        cvId: candidate.cv_id,
        text: body.replace(/\n{3,}/g, '\n\n').trim(),
        viewedAt: new Date().toISOString(),
      }
      const profilePath = path.join(destination, 'profile.json')
      await writeJsonAtomic(profilePath, profile)
      result.profile = {
        status: 'downloaded',
        path: profilePath,
        size_bytes: Buffer.byteLength(profile.text),
      }

      const tabClicked = await js(String.raw`(() => {
        const tab = [...document.querySelectorAll('a')]
          .find((anchor) => anchor.innerText.trim() === 'CV attachment')
        if (!tab) return false
        tab.click()
        return true
      })()`)
      if (!tabClicked) {
        result.original = { status: 'not_available', reason: 'CV attachment tab missing' }
      } else {
        await wait(0.7)
        const setup = await js(String.raw`(() => {
          const action = [...document.querySelectorAll('a')]
            .find((anchor) => anchor.dataset.automationId === 'DownloadCV' && anchor.innerText.trim() === 'Download')
          if (!action) return false
          window.__baytCapturedDownload = null
          window.__baytRealOpen = window.open
          window.open = (url) => {
            window.__baytCapturedDownload = String(url || '')
            return { focus() {}, closed: false }
          }
          action.click()
          return true
        })()`)
        if (!setup) {
          result.original = { status: 'not_available', reason: 'original attachment absent' }
        } else {
          let signedUrl = ''
          for (let signedAttempt = 0; signedAttempt < 12; signedAttempt += 1) {
            await wait(0.35)
            signedUrl = await js(`window.__baytCapturedDownload || ''`)
            if (signedUrl) break
          }
          await js(`(() => {
            if (window.__baytRealOpen) window.open = window.__baytRealOpen
            delete window.__baytRealOpen
          })()`)
          if (!signedUrl) {
            if (attempt < 3) throw new Error('signed original URL was not captured')
            result.original = {
              status: 'not_available',
              reason: 'attachment action produced no URL, file, or tab after 3 attempts',
            }
          } else {
            const cookies = (await cdp('Network.getAllCookies')).cookies || []
            const hostname = new URL(signedUrl).hostname
            const cookieHeader = cookies
              .filter((cookie) => {
                const domain = cookie.domain.replace(/^\./, '')
                return hostname === domain || hostname.endsWith(`.${domain}`)
              })
              .map((cookie) => `${cookie.name}=${cookie.value}`)
              .join('; ')
            const userAgent = await js(`navigator.userAgent`)
            const response = await fetch(signedUrl, {
              headers: {
                'User-Agent': userAgent,
                Cookie: cookieHeader,
                Referer: (await pageInfo()).url,
                Accept: 'application/pdf,application/octet-stream,*/*',
              },
            })
            const buffer = Buffer.from(await response.arrayBuffer())
            const mimeType = response.headers.get('content-type') || ''
            if (!response.ok || /text\/html/i.test(mimeType) || buffer.length < 100) {
              throw new Error(`invalid original response ${response.status} ${mimeType} ${buffer.length}`)
            }
            const originalName = dispositionName(response.headers.get('content-disposition'))
            const originalPath = path.join(destination, `original${extensionFor(mimeType, originalName)}`)
            await fs.writeFile(originalPath, buffer, { mode: 0o600 })
            result.original = {
              status: 'downloaded',
              path: originalPath,
              original_name: originalName,
              mime_type: mimeType,
              size_bytes: buffer.length,
              sha256: sha256(buffer),
            }
          }
        }
      }
      result.status = 'complete'
      result.completed_at = new Date().toISOString()
      delete result.error
      await writeJsonAtomic(path.join(destination, 'result.json'), result)
      return result
    } catch (error) {
      result.error = String(error?.message || error)
      if (result.error.startsWith('RATE_LIMITED:')) result.status = 'rate_limited'
      else if (result.error.startsWith('SAFETY_STOP:')) result.status = 'paused'
      else result.status = attempt === 3 ? 'failed' : 'retrying'
      await writeJsonAtomic(path.join(destination, 'result.json'), result)
      if (result.status === 'rate_limited' || result.status === 'paused') throw error
      if (attempt < 3) await wait(attempt)
    }
  }
  return result
}

let completed = 0
let failed = 0
for (const candidate of candidates) {
  const result = await collectCandidate(candidate)
  if (result.status === 'complete') completed += 1
  else failed += 1
  await writeJsonAtomic(path.join(batchRoot, 'progress.json'), {
    page_no: pageNo,
    total: candidates.length,
    completed,
    failed,
    last_cv_id: candidate.cv_id,
    updated_at: new Date().toISOString(),
  })
  cliLog(`candidate=${candidate.cv_id} status=${result.status} completed=${completed} failed=${failed}`)
}

const finalRuntimeState = await readJson(runtimeStatePath)
await writeJsonAtomic(runtimeStatePath, {
  ...finalRuntimeState,
  status: failed ? 'page_failed' : 'page_completed',
  page_no: pageNo,
  completed,
  failed,
  updated_at: new Date().toISOString(),
})
cliLog(`PAGE_COMPLETE ${JSON.stringify({ pageNo, total: candidates.length, completed, failed })}`)
if (failed) throw new Error(`Page ${pageNo} completed with ${failed} failed candidates`)
EOF
