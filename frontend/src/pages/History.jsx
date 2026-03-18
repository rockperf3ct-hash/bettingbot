import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'
import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, Legend,
} from 'recharts'

const API_BASE = import.meta.env.VITE_API_BASE || ''

function pct(v, dec = 1) { return v == null ? '—' : (Number(v) * 100).toFixed(dec) + '%' }
function num(v, dec = 0)  { return v == null ? '—' : Number(v).toFixed(dec) }

const RESULT_COLOR = { won: 'text-green-400', lost: 'text-red-400', push: 'text-gray-400', pending: 'text-yellow-500' }
const TIER_BADGE = {
  Strong:   'bg-green-900/60 text-green-300 border border-green-700',
  Moderate: 'bg-yellow-900/50 text-yellow-300 border border-yellow-700',
  Lean:     'bg-navy-700 text-gray-400 border border-navy-600',
}
const SPORT_ICON = { soccer: '⚽', nba: '🏀', mlb: '⚾' }

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------
function StatCard({ label, value, sub, color }) {
  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 text-center">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color || 'text-gray-100'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overall stats strip
// ---------------------------------------------------------------------------
function StatsStrip({ stats }) {
  if (!stats) return null
  const ov = stats.overall
  const hitColor = ov.hit_rate == null ? 'text-gray-400'
    : ov.hit_rate >= 0.55 ? 'text-green-400'
    : ov.hit_rate >= 0.50 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <StatCard label="Total Picks" value={ov.total + (ov.pending ? ` (+${ov.pending} pending)` : '')} />
      <StatCard label="Won"    value={ov.won}  color="text-green-400" />
      <StatCard label="Lost"   value={ov.lost} color="text-red-400" />
      <StatCard label="Hit Rate" value={pct(ov.hit_rate)} color={hitColor}
        sub={ov.total ? `${ov.won}/${ov.total - (ov.pending||0)} settled` : null} />
      <StatCard label="Avg Edge" value={pct(ov.avg_edge)} sub="model edge" />
      <StatCard label="Avg Model Prob" value={pct(ov.avg_model_prob)} sub="confidence" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// By sport / tier breakdown
// ---------------------------------------------------------------------------
function BreakdownTable({ title, data }) {
  if (!data || Object.keys(data).length === 0) return null
  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{title}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase border-b border-navy-700">
            <th className="pb-2 text-left">Category</th>
            <th className="pb-2 text-right">W</th>
            <th className="pb-2 text-right">L</th>
            <th className="pb-2 text-right">Total</th>
            <th className="pb-2 text-right">Hit Rate</th>
            <th className="pb-2 text-right">Avg Edge</th>
            <th className="pb-2 text-right">Pending</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-700/50">
          {Object.entries(data).map(([key, s]) => {
            const hr = s.hit_rate
            const color = hr == null ? 'text-gray-400'
              : hr >= 0.55 ? 'text-green-400'
              : hr >= 0.50 ? 'text-yellow-400' : 'text-red-400'
            return (
              <tr key={key}>
                <td className="py-2.5 font-medium text-gray-200">
                  {SPORT_ICON[key] || ''} {key}
                </td>
                <td className="py-2.5 text-right text-green-400">{s.won}</td>
                <td className="py-2.5 text-right text-red-400">{s.lost}</td>
                <td className="py-2.5 text-right text-gray-400">{s.total}</td>
                <td className={`py-2.5 text-right font-bold ${color}`}>{pct(hr)}</td>
                <td className="py-2.5 text-right text-gray-400">{pct(s.avg_edge)}</td>
                <td className="py-2.5 text-right text-gray-600">{s.pending || 0}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rolling hit rate chart
// ---------------------------------------------------------------------------
function RollingChart({ data, window }) {
  if (!data?.length) return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-8 text-center text-gray-600 text-sm">
      Not enough data yet — resolves will populate this chart over time.
    </div>
  )
  const key = `rolling_${window}d_hit_rate`
  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">
        Rolling {window}-Day Hit Rate
      </h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }}
            tickFormatter={v => v?.slice(5)} />
          <YAxis domain={[0, 1]} tick={{ fill: '#6b7280', fontSize: 10 }}
            tickFormatter={v => pct(v, 0)} />
          <Tooltip
            contentStyle={{ background: '#111827', border: '1px solid #374151' }}
            labelStyle={{ color: '#9ca3af' }}
            formatter={(v, name) => [pct(v), name === key ? `${window}-day rolling` : 'Daily']}
          />
          <ReferenceLine y={0.55} stroke="#22c55e" strokeDasharray="4 2"
            label={{ value: '55%', fill: '#22c55e', fontSize: 10 }} />
          <ReferenceLine y={0.50} stroke="#374151" strokeDasharray="4 2" />
          <Line type="monotone" dataKey="daily_hit_rate" stroke="#374151"
            dot={{ r: 3, fill: '#374151' }} strokeWidth={1} name="Daily" />
          <Line type="monotone" dataKey={key} stroke="#3b82f6"
            dot={false} strokeWidth={2} name={`${window}d rolling`} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Calibration chart
// ---------------------------------------------------------------------------
function CalibrationChart({ data }) {
  if (!data?.length) return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-8 text-center text-gray-600 text-sm">
      Need more resolved picks to show calibration.
    </div>
  )
  // Add perfect calibration line
  const perfect = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
        Model Calibration
      </h3>
      <p className="text-xs text-gray-600 mb-4">
        Bars = actual hit rate per confidence bucket. Dashed = perfect calibration.
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis dataKey="avg_model_prob" tick={{ fill: '#6b7280', fontSize: 10 }}
            tickFormatter={v => pct(v, 0)} label={{ value: 'Model Prob', fill: '#6b7280', fontSize: 10, position: 'insideBottom', offset: -2 }} />
          <YAxis domain={[0, 1]} tick={{ fill: '#6b7280', fontSize: 10 }}
            tickFormatter={v => pct(v, 0)} />
          <Tooltip
            contentStyle={{ background: '#111827', border: '1px solid #374151' }}
            formatter={(v, name) => [pct(v), name === 'actual_hit_rate' ? 'Actual Hit Rate' : name]}
            labelFormatter={v => `Model prob: ${pct(v, 0)}`}
          />
          <Bar dataKey="actual_hit_rate" fill="#3b82f6" radius={[3, 3, 0, 0]} />
          <ReferenceLine
            segment={[{ x: data[0]?.avg_model_prob, y: data[0]?.avg_model_prob },
                       { x: data[data.length-1]?.avg_model_prob, y: data[data.length-1]?.avg_model_prob }]}
            stroke="#22c55e" strokeDasharray="4 2"
          />
        </BarChart>
      </ResponsiveContainer>
      <p className="text-xs text-gray-600 mt-2 text-center">
        If bars match the dashed line, the model is well-calibrated.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Predictions log table
// ---------------------------------------------------------------------------
function PredictionsTable({ rows, loading, error }) {
  if (loading) return <Loader />
  if (error) return <ErrorBox message={error} />
  if (!rows.length) return (
    <p className="text-gray-600 text-sm text-center py-6">
      No prediction history yet. Picks are logged automatically each time you visit the AI Picks page.
    </p>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase border-b border-navy-700">
            <th className="pb-2 text-left">Date</th>
            <th className="pb-2 text-left">League</th>
            <th className="pb-2 text-left">Pick</th>
            <th className="pb-2 text-left">Matchup</th>
            <th className="pb-2 text-right">Edge</th>
            <th className="pb-2 text-right">Odds</th>
            <th className="pb-2 text-right">Model%</th>
            <th className="pb-2 text-center">Tier</th>
            <th className="pb-2 text-center">Result</th>
            <th className="pb-2 text-center">Score</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-700/50">
          {rows.map(r => (
            <tr key={r.id} className="hover:bg-navy-700/30 transition-colors">
              <td className="py-2.5 text-gray-500 text-xs">{r.pick_date}</td>
              <td className="py-2.5 text-gray-400 text-xs">{r.league}</td>
              <td className="py-2.5 font-medium text-gray-200">{r.bet_team}</td>
              <td className="py-2.5 text-gray-400 text-xs">{r.home_team} vs {r.away_team}</td>
              <td className="py-2.5 text-right text-gray-300">{pct(r.edge)}</td>
              <td className="py-2.5 text-right text-gray-400">{num(r.odds, 2)}x</td>
              <td className="py-2.5 text-right text-gray-400">{pct(r.model_prob)}</td>
              <td className="py-2.5 text-center">
                {r.tier && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${TIER_BADGE[r.tier] || ''}`}>
                    {r.tier}
                  </span>
                )}
              </td>
              <td className={`py-2.5 text-center font-bold text-xs ${RESULT_COLOR[r.result] || ''}`}>
                {r.result === 'won' ? 'W' : r.result === 'lost' ? 'L'
                  : r.result === 'push' ? 'P' : r.result === 'pending' ? '⏳' : r.result}
              </td>
              <td className="py-2.5 text-center text-gray-500 text-xs">
                {r.home_score != null ? `${r.home_score}–${r.away_score}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resolve button
// ---------------------------------------------------------------------------
function ResolveButton({ onResolved }) {
  const [loading, setLoading] = useState(null)  // null | 'today' | 'yesterday'
  const [msg, setMsg] = useState(null)

  async function resolve(targetDate, label) {
    setLoading(label); setMsg(null)
    try {
      const url = `${API_BASE}/api/predictions/resolve?target_date=${targetDate}`
      const r = await fetch(url, { method: 'POST' })
      const d = await r.json()
      const count = d.resolved ?? 0
      const pending = d.not_found ?? 0
      if (count === 0 && pending === 0) {
        setMsg(`No pending picks found for ${d.date}.`)
      } else {
        setMsg(`${d.date}: ${d.won}W ${d.lost}L ${d.push ?? 0}P — ${count} resolved, ${pending} not found`)
      }
      onResolved()
    } catch (e) {
      setMsg('Error: ' + e.message)
    } finally { setLoading(null) }
  }

  const today     = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
  const twoDaysAgo = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => resolve(yesterday, 'yesterday')} disabled={!!loading}
          className="text-xs bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors">
          {loading === 'yesterday' ? 'Resolving…' : `Resolve Yesterday (${yesterday})`}
        </button>
        <button onClick={() => resolve(today, 'today')} disabled={!!loading}
          className="text-xs bg-navy-700 hover:bg-navy-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors border border-navy-600">
          {loading === 'today' ? 'Resolving…' : `Resolve Today (${today})`}
        </button>
        <button onClick={() => resolve(twoDaysAgo, 'twodaysago')} disabled={!!loading}
          className="text-xs bg-navy-700 hover:bg-navy-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors border border-navy-600">
          {loading === 'twodaysago' ? 'Resolving…' : `Resolve ${twoDaysAgo}`}
        </button>
      </div>
      {msg && (
        <p className={`text-xs ${msg.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
          {msg}
        </p>
      )}
      <p className="text-xs text-gray-600">
        Fetches final scores from ESPN and marks pending picks as Won / Lost / Push.
        Use "Yesterday" for picks placed yesterday.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function History() {
  const [rollingWindow, setRollingWindow] = useState(7)
  const [refresh, setRefresh] = useState(0)

  const statsApi   = useApi(`/api/predictions/stats?_r=${refresh}`)
  const rollingApi = useApi(`/api/predictions/rolling?window=${rollingWindow}&_r=${refresh}`)
  const calibApi   = useApi(`/api/predictions/calibration?_r=${refresh}`)
  const predsApi   = useApi(`/api/predictions?limit=100&_r=${refresh}`)

  const stats   = statsApi.data
  const rolling = rollingApi.data ?? []
  const calib   = calibApi.data ?? []
  const preds   = predsApi.data?.predictions ?? []

  function refetchAll() { setRefresh(r => r + 1) }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Prediction History</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            W/R tracking for AI picks — auto-resolved daily from ESPN results
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <ResolveButton onResolved={refetchAll} />
          <button onClick={refetchAll}
            className="text-xs text-gray-500 hover:text-gray-300 border border-navy-600 rounded-lg px-3 py-2">
            Refresh
          </button>
        </div>
      </div>

      {/* How it works note */}
      <div className="bg-navy-800 border border-navy-700 rounded-lg px-4 py-3 text-xs text-gray-500 space-y-1">
        <p className="font-semibold text-gray-400">How it works</p>
        <p>Every time you open AI Picks, today's picks are logged here. The daily pipeline (or the button above) fetches yesterday's ESPN scores and auto-marks each pick Won / Lost / Push.</p>
      </div>

      {/* Summary stats */}
      {statsApi.loading ? <Loader /> : <StatsStrip stats={stats} />}

      {/* By sport + tier */}
      <div className="grid gap-4 md:grid-cols-2">
        <BreakdownTable title="By Sport" data={stats?.by_sport} />
        <BreakdownTable title="By Tier" data={stats?.by_tier} />
      </div>

      {/* Rolling chart */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-300">Rolling Accuracy</h2>
          <div className="flex gap-1">
            {[7, 14, 30].map(w => (
              <button key={w} onClick={() => setRollingWindow(w)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                  rollingWindow === w
                    ? 'bg-brand-600 border-brand-500 text-white'
                    : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
                }`}>
                {w}d
              </button>
            ))}
          </div>
        </div>
        <RollingChart data={rolling} window={rollingWindow} />
      </div>

      {/* Calibration */}
      <CalibrationChart data={calib} />

      {/* Full prediction log */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">
          All Predictions
          {preds.length > 0 && <span className="text-gray-600 font-normal ml-2">({preds.length})</span>}
        </h2>
        <PredictionsTable rows={preds} loading={predsApi.loading} error={predsApi.error} />
      </div>

      <p className="text-xs text-gray-600 text-center pb-2">
        Hit rate above 55% sustained over 100+ picks is considered strong performance.
        Results are from AI model picks only — not guaranteed profit.
      </p>
    </div>
  )
}
