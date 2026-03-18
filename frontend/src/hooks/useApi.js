import { useState, useEffect, useCallback, useRef } from 'react'

async function buildHttpError(response, url) {
  let detail = ''
  try {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const body = await response.json()
      if (body && typeof body === 'object') {
        if (typeof body.detail === 'string') detail = body.detail
        else if (body.detail != null) detail = JSON.stringify(body.detail)
        else detail = JSON.stringify(body)
      }
    } else {
      const txt = await response.text()
      detail = (txt || '').trim()
    }
  } catch {
    detail = ''
  }

  const base = `${response.status} ${response.statusText}`
  const withDetail = detail ? `${base} - ${detail}` : base
  return `${withDetail} [${url}]`
}

/**
 * useApi(url, options)
 *
 * options:
 *   interval  — auto-refresh interval in ms (e.g. 60000 = 1 min). 0 = disabled.
 *
 * Returns: { data, loading, error, refetch, secondsUntilRefresh }
 */
export function useApi(url, { interval = 0 } = {}) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(!!url)
  const [error, setError]     = useState(null)
  const [tick, setTick]       = useState(0)
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState(interval > 0 ? interval / 1000 : null)

  // Auto-refresh interval
  const intervalRef = useRef(null)
  const countdownRef = useRef(null)

  useEffect(() => {
    if (interval > 0 && url) {
      // Clear any existing timers
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)

      setSecondsUntilRefresh(interval / 1000)

      // Main refresh timer
      intervalRef.current = setInterval(() => {
        setTick(t => t + 1)
        setSecondsUntilRefresh(interval / 1000)
      }, interval)

      // Countdown display (updates every second)
      countdownRef.current = setInterval(() => {
        setSecondsUntilRefresh(s => (s != null && s > 0) ? s - 1 : s)
      }, 1000)

      return () => {
        clearInterval(intervalRef.current)
        clearInterval(countdownRef.current)
      }
    }
  }, [url, interval])

  // Fetch effect
  useEffect(() => {
    if (!url) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(url)
      .then(async r => {
        if (!r.ok) {
          throw new Error(await buildHttpError(r, url))
        }
        return r.json()
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [url, tick])

  const refetch = useCallback(() => {
    setTick(t => t + 1)
    if (interval > 0) setSecondsUntilRefresh(interval / 1000)
  }, [interval])

  return { data, loading, error, refetch, secondsUntilRefresh }
}
