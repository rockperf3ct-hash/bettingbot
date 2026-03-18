/**
 * My Bets / Profile — personal bet history, P&L, and AI brutal critique.
 */
import { useState, useRef } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'

const API = 'http://localhost:8000'

async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || r.statusText) }
  return r.json()
}

async function patch(path, body) {
  const r = await fetch(API + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || r.statusText) }
  return r.json()
}

async function del(path) {
  const r = await fetch(API + path, { method: 'DELETE' })
  if (!r.ok && r.status !== 204) throw new Error(r.statusText)
}

function fmt(n, d = 2) { return n == null ? '—' : Number(n).toFixed(d) }
function pct(n) { return n == null ? '—' : (n * 100).toFixed(1) + '%' }
function currency(n, showSign = false) {
  if (n == null) return '—'
  const abs = Math.abs(Number(n))
  const s = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (showSign) return (n >= 0 ? '+' : '-') + s
  return s
}
function toAmerican(dec) {
  if (!dec || dec <= 1) return '—'
  return dec >= 2 ? '+' + Math.round((dec - 1) * 100) : '-' + Math.round(100 / (dec - 1))
}

const RESULT_CONFIG = {
  won:  { label: 'W', cls: 'bg-win text-green-300 border' },
  lost: { label: 'L', cls: 'bg-loss text-red-300 border' },
  void: { label: 'V', cls: 'bg-push text-gray-400 border' },
}

// ---------------------------------------------------------------------------
// Stats strip
// ---------------------------------------------------------------------------
function StatsStrip({ stats }) {
  if (!stats) return null
  const pnlPos = (stats.total_pnl ?? 0) >= 0
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
      <div className="profile-stat">
        <p className="text-2xl font-black text-white">{stats.total ?? 0}</p>
        <p className="text-xs text-gray-500 mt-1">Total Bets</p>
      </div>
      <div className="profile-stat">
        <p className="text-2xl font-black text-green-400">{stats.won ?? 0}</p>
        <p className="text-xs text-gray-500 mt-1">Won</p>
      </div>
      <div className="profile-stat">
        <p className="text-2xl font-black text-red-400">{stats.lost ?? 0}</p>
        <p className="text-xs text-gray-500 mt-1">Lost</p>
      </div>
      <div className="profile-stat">
        <p className="text-2xl font-black text-gray-400">{stats.pending ?? 0}</p>
        <p className="text-xs text-gray-500 mt-1">Pending</p>
      </div>
      <div className="profile-stat">
        <p className={`text-2xl font-black ${stats.hit_rate >= 0.54 ? 'text-green-400' : stats.hit_rate >= 0.50 ? 'text-yellow-400' : 'text-red-400'}`}>
          {pct(stats.hit_rate)}
        </p>
        <p className="text-xs text-gray-500 mt-1">Hit Rate</p>
      </div>
      <div className="profile-stat col-span-1">
        <p className={`text-2xl font-black ${pnlPos ? 'text-green-400' : 'text-red-400'}`}>
          {currency(stats.total_pnl, true)}
        </p>
        <p className="text-xs text-gray-500 mt-1">P&L</p>
      </div>
      <div className="profile-stat">
        <p className="text-2xl font-black text-blue-400">
          {stats.roi != null ? (stats.roi >= 0 ? '+' : '') + pct(stats.roi) : '—'}
        </p>
        <p className="text-xs text-gray-500 mt-1">ROI</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI Critic panel
// ---------------------------------------------------------------------------
function CriticPanel({ bet }) {
  const [open, setOpen]       = useState(false)
  const [loading, setLoading] = useState(false)
  const [critique, setCritique] = useState(null)
  const [error, setError]     = useState(null)

  const runCritic = async () => {
    if (critique) { setOpen(o => !o); return }
    setLoading(true); setError(null)
    try {
      const res = await post('/api/critic/bet', {
        bet_id:     bet.id,
        bet_team:   bet.bet_team,
        league:     bet.league,
        sport:      bet.sport,
        bet_type:   bet.bet_type || 'moneyline',
        odds:       bet.odds,
        stake:      bet.stake,
        model_prob: bet.model_prob,
        edge:       bet.edge,
        result:     bet.result,
        pnl:        bet.pnl,
        notes:      bet.notes,
      })
      setCritique(res)
      setOpen(true)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }

  return (
    <div className="mt-2">
      <button
        onClick={runCritic}
        disabled={loading}
        className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 flex items-center gap-1 transition-colors"
      >
        {loading ? (
          <span className="animate-pulse">Analyzing…</span>
        ) : (
          <span>{critique ? (open ? '▲ Hide critique' : '▼ Show AI critique') : '🤖 Get AI critique'}</span>
        )}
      </button>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      {open && critique && (
        <div className="mt-2 bg-navy-950 border border-navy-700 rounded-lg p-3 space-y-2 animate-fade-in">
          {/* Metrics row */}
          <div className="flex flex-wrap gap-2 text-xs">
            {critique.ev_per_unit != null && (
              <span className={`stat-chip ${critique.ev_per_unit >= 0 ? 'green' : 'red'}`}>
                EV {critique.ev_per_unit >= 0 ? '+' : ''}{(critique.ev_per_unit * 100).toFixed(2)}%
              </span>
            )}
            {critique.kelly_pct != null && (
              <span className="stat-chip blue">Kelly {critique.kelly_pct}%</span>
            )}
            {critique.edge != null && (
              <span className={`stat-chip ${critique.edge >= 0.03 ? 'green' : 'red'}`}>
                Edge {(critique.edge * 100).toFixed(1)}%
              </span>
            )}
          </div>
          {/* Critique text */}
          <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">
            {critique.critique}
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settle controls
// ---------------------------------------------------------------------------
function SettleControls({ bet, onSettled, onDeleted }) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  const settle = async (result) => {
    setLoading(true); setError(null)
    try {
      await patch(`/api/tracker/bets/${bet.id}/settle`, { result })
      onSettled()
    } catch (e) { setError(e.message) }
    setLoading(false)
  }

  const remove = async () => {
    if (!confirm('Delete this bet?')) return
    setLoading(true)
    try { await del(`/api/tracker/bets/${bet.id}`); onDeleted() }
    catch (e) { setError(e.message) }
    setLoading(false)
  }

  if (bet.result && bet.result !== 'pending') return null

  return (
    <div className="flex items-center gap-2 mt-2 flex-wrap">
      <button onClick={() => settle('won')}  disabled={loading} className="text-xs bg-green-900/50 border border-green-800 text-green-400 hover:bg-green-900/80 px-2 py-1 rounded transition-colors disabled:opacity-50">Won</button>
      <button onClick={() => settle('lost')} disabled={loading} className="text-xs bg-red-900/50 border border-red-800 text-red-400 hover:bg-red-900/80 px-2 py-1 rounded transition-colors disabled:opacity-50">Lost</button>
      <button onClick={() => settle('void')} disabled={loading} className="text-xs bg-navy-700 border border-navy-600 text-gray-400 hover:bg-navy-600 px-2 py-1 rounded transition-colors disabled:opacity-50">Void</button>
      <button onClick={remove}               disabled={loading} className="text-xs text-gray-600 hover:text-red-400 px-2 py-1 transition-colors disabled:opacity-50">Delete</button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bet row
// ---------------------------------------------------------------------------
function BetRow({ bet, onRefresh }) {
  const rc = RESULT_CONFIG[bet.result] || null
  const pnlPos = (bet.pnl ?? 0) >= 0

  return (
    <div className={`bg-navy-800 border rounded-xl p-4 space-y-1 ${
      bet.result === 'won' ? 'border-green-900/60' :
      bet.result === 'lost' ? 'border-red-900/60' :
      'border-navy-700'
    }`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white">{bet.bet_team}</span>
            {rc && (
              <span className={`text-xs font-black px-1.5 py-0.5 rounded border ${rc.cls}`}>
                {rc.label}
              </span>
            )}
            {bet.tier && (
              <span className={`stat-chip ${bet.tier === 'Strong' ? 'green' : bet.tier === 'Moderate' ? 'yellow' : 'gray'}`}>
                {bet.tier}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {bet.bet_type_label || bet.bet_type || 'Moneyline'} · {bet.league} · {bet.home_team} vs {bet.away_team}
          </p>
          <p className="text-xs text-gray-600 mt-0.5">{bet.date}</p>
        </div>

        {/* Right: odds + P&L */}
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-white">{toAmerican(bet.odds)}</p>
          <p className="text-xs text-gray-500">{bet.odds?.toFixed(2)} dec</p>
          {bet.result && bet.pnl != null && (
            <p className={`text-xs font-bold mt-1 ${pnlPos ? 'text-green-400' : 'text-red-400'}`}>
              {currency(bet.pnl, true)}
            </p>
          )}
          {bet.stake != null && (
            <p className="text-xs text-gray-600">
              ${bet.stake.toFixed(2)} stake
            </p>
          )}
        </div>
      </div>

      {/* Stats: edge + model prob */}
      {(bet.edge != null || bet.model_prob != null) && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          {bet.edge != null && (
            <span className={`stat-chip ${bet.edge >= 0.05 ? 'green' : bet.edge >= 0.02 ? 'yellow' : 'red'}`}>
              {pct(bet.edge)} edge
            </span>
          )}
          {bet.model_prob != null && (
            <span className="stat-chip blue">{pct(bet.model_prob)} model prob</span>
          )}
        </div>
      )}

      {bet.notes && <p className="text-xs text-gray-600 italic">{bet.notes}</p>}

      {/* Settle + critic */}
      <SettleControls bet={bet} onSettled={onRefresh} onDeleted={onRefresh} />
      <CriticPanel bet={bet} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session Critic
// ---------------------------------------------------------------------------
function SessionCritic({ onClose }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState(null)

  const run = async () => {
    setLoading(true); setError(null)
    try {
      const res = await post('/api/critic/session', {})
      setResult(res)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-navy-900 border border-navy-700 rounded-2xl p-6 max-w-lg w-full shadow-slip animate-fade-in space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-bold text-white">AI Session Review</h2>
            <p className="text-xs text-gray-500 mt-0.5">Brutal honest analysis of your full betting history</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
        </div>

        {!result && !loading && (
          <button
            onClick={run}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl text-sm transition-colors"
          >
            Analyze My Betting
          </button>
        )}

        {loading && (
          <div className="text-center py-4">
            <div className="animate-pulse text-sm text-gray-400">Analyzing your bets…</div>
          </div>
        )}

        {error && <ErrorBox message={error} />}

        {result && (
          <div className="space-y-3">
            {/* Stats row */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-navy-800 rounded-lg p-2">
                <p className={`text-lg font-black ${result.summary?.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {currency(result.summary?.total_pnl, true)}
                </p>
                <p className="text-xs text-gray-600">P&L</p>
              </div>
              <div className="bg-navy-800 rounded-lg p-2">
                <p className="text-lg font-black text-white">
                  {result.summary?.hit_rate != null ? pct(result.summary.hit_rate) : '—'}
                </p>
                <p className="text-xs text-gray-600">Hit Rate</p>
              </div>
              <div className="bg-navy-800 rounded-lg p-2">
                <p className="text-lg font-black text-blue-400">
                  {result.summary?.total_bets ?? 0}
                </p>
                <p className="text-xs text-gray-600">Total Bets</p>
              </div>
            </div>

            {/* Critique */}
            <div className="bg-navy-950 border border-navy-700 rounded-xl p-4">
              <p className="text-xs text-gray-500 font-semibold mb-2 uppercase tracking-wider">AI Verdict</p>
              <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                {result.critique}
              </p>
            </div>

            {result.summary?.worst_league && (
              <p className="text-xs text-red-400">
                Worst league: <strong>{result.summary.worst_league}</strong> — consider avoiding
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Profile page
// ---------------------------------------------------------------------------
export default function Profile() {
  const [filter, setFilter]     = useState('all')
  const [showCritic, setShowCritic] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

  const resultFilter = filter === 'all' ? undefined : filter
  const { data: statsData } = useApi(`${API}/api/tracker/summary`, { })
  const { data: betsData, loading, error } = useApi(
    `${API}/api/tracker/bets?limit=200${resultFilter ? '&result=' + resultFilter : ''}`,
    { }
  )

  // Re-fetch when tick changes
  const [tick, setTick] = useState(0)
  const refresh = () => setTick(t => t + 1)

  const { data: betsDataLive, loading: liveLoading, error: liveError } = useApi(
    `${API}/api/tracker/bets?limit=200${resultFilter ? '&result=' + resultFilter : ''}&_t=${tick}`
  )
  const { data: statsLive } = useApi(`${API}/api/tracker/summary&_t=${tick}`)

  const stats = statsLive || statsData
  const bets  = (betsDataLive || betsData)?.bets ?? []

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">My Bets</h1>
          <p className="text-xs text-gray-500 mt-0.5">Personal bet tracker · Settle results to build your P&L</p>
        </div>
        <button
          onClick={() => setShowCritic(true)}
          className="flex items-center gap-2 bg-navy-800 border border-navy-700 hover:border-blue-600 text-sm text-gray-300 hover:text-white px-4 py-2 rounded-xl transition-colors"
        >
          <span>🤖</span>
          <span>AI Session Review</span>
        </button>
      </div>

      {/* Stats */}
      <StatsStrip stats={stats} />

      {/* Filter tabs */}
      <div className="flex items-center gap-1 bg-navy-900 border border-navy-700 rounded-xl p-1 w-fit">
        {[
          ['all',     'All'],
          ['pending', 'Pending'],
          ['won',     'Won'],
          ['lost',    'Lost'],
          ['void',    'Void'],
        ].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
              filter === v
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Bet list */}
      {(loading || liveLoading) && <Loader />}
      {(error || liveError) && <ErrorBox message={error || liveError} />}

      {!loading && !liveLoading && bets.length === 0 && (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">📋</p>
          <p className="text-sm text-gray-500">No bets recorded yet.</p>
          <p className="text-xs text-gray-600 mt-1">
            Go to the Dashboard, click any odds button, enter a stake, and place a bet.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {bets.map(bet => (
          <BetRow key={bet.id} bet={bet} onRefresh={refresh} />
        ))}
      </div>

      {/* Session critic modal */}
      {showCritic && <SessionCritic onClose={() => setShowCritic(false)} />}
    </div>
  )
}
