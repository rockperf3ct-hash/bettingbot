import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'
import Card from '../components/Card'
import {
  ResponsiveContainer, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from 'recharts'

function fmt(n, d = 4) {
  if (n == null) return '—'
  return Number(n).toFixed(d)
}

function pct(n, d = 1) {
  if (n == null) return '—'
  return (Number(n) * 100).toFixed(d) + '%'
}

const SPORT_META = {
  soccer: { label: 'Soccer', icon: '⚽', color: '#22c55e' },
  nba:    { label: 'NBA',    icon: '🏀', color: '#f97316' },
  mlb:    { label: 'MLB',    icon: '⚾', color: '#3b82f6' },
}

// ── Fold metrics bar chart ──────────────────────────────────────────────────
function FoldChart({ folds }) {
  const data = folds.map(f => ({
    name:     `Fold ${f.fold}`,
    log_loss: Number((f.log_loss ?? 0).toFixed(4)),
    brier:    Number((f.brier ?? 0).toFixed(4)),
    roc_auc:  Number((f.roc_auc ?? 0).toFixed(4)),
  }))
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 11 }} />
        <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} domain={[0, 1]} />
        <Tooltip
          contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
          labelStyle={{ color: '#9ca3af', fontSize: 11 }}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: '#6b7280' }} />
        <Bar dataKey="log_loss" name="Log Loss" fill="#f97316" radius={[4,4,0,0]} />
        <Bar dataKey="brier"    name="Brier"    fill="#3b82f6" radius={[4,4,0,0]} />
        <Bar dataKey="roc_auc"  name="ROC AUC"  fill="#22c55e" radius={[4,4,0,0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Sport model card ────────────────────────────────────────────────────────
function SportModelCard({ sport, summary }) {
  const m = SPORT_META[sport] ?? { label: sport, icon: '🏟️', color: '#6b7280' }
  if (!summary || summary.skipped) {
    return (
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-5 opacity-50">
        <p className="text-sm font-semibold text-gray-400">{m.icon} {m.label}</p>
        <p className="text-xs text-gray-600 mt-1">Insufficient data to train</p>
      </div>
    )
  }
  const aucColor = (summary.avg_roc_auc ?? 0) >= 0.58 ? 'text-green-400'
                 : (summary.avg_roc_auc ?? 0) >= 0.55 ? 'text-yellow-400'
                 : 'text-red-400'

  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-gray-100">{m.icon} {m.label}</p>
        <span className="text-xs bg-navy-700 text-gray-400 px-2 py-0.5 rounded">{summary.best_model}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="bg-navy-700 rounded-lg p-2">
          <p className="text-xs text-gray-500">ROC AUC</p>
          <p className={`text-lg font-bold ${aucColor}`}>{fmt(summary.avg_roc_auc, 3)}</p>
        </div>
        <div className="bg-navy-700 rounded-lg p-2">
          <p className="text-xs text-gray-500">Hit Rate</p>
          <p className="text-lg font-bold text-gray-200">{pct(summary.hit_rate)}</p>
        </div>
        <div className="bg-navy-700 rounded-lg p-2">
          <p className="text-xs text-gray-500">Yield</p>
          <p className={`text-lg font-bold ${(summary.yield ?? 0) > 0 ? 'text-green-400' : 'text-red-400'}`}>
            {pct(summary.yield)}
          </p>
        </div>
        <div className="bg-navy-700 rounded-lg p-2">
          <p className="text-xs text-gray-500">Bets</p>
          <p className="text-lg font-bold text-gray-200">{summary.bets_placed?.toLocaleString()}</p>
        </div>
      </div>
      <div className="text-xs text-gray-600">
        {summary.rows?.toLocaleString()} training games
        {summary.simulated_odds_games
          ? ` · ${summary.simulated_odds_games.toLocaleString()} simulated odds`
          : ''}
      </div>
    </div>
  )
}

// ── Benchmark table ─────────────────────────────────────────────────────────
function BenchmarkTable({ benchmark }) {
  const ranking   = benchmark?.ranking ?? []
  const bestModel = benchmark?.best_model
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-gray-500 text-xs uppercase tracking-wider border-b border-navy-700">
          <tr>
            <th className="pb-3 text-left">Rank</th>
            <th className="pb-3 text-left">Model</th>
            <th className="pb-3 text-right">Avg Log Loss</th>
            <th className="pb-3 text-right">Avg Brier</th>
            <th className="pb-3 text-right">Avg ROC AUC</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-700">
          {ranking.map((r, i) => {
            const detail = benchmark.models?.[r.model] ?? {}
            return (
              <tr key={r.model} className={r.model === bestModel ? 'bg-brand-900/20' : 'bg-navy-900'}>
                <td className="px-2 py-3 text-gray-500">{i + 1}</td>
                <td className="px-2 py-3 text-gray-100 font-medium">
                  {r.model}
                  {r.model === bestModel && (
                    <span className="ml-2 text-xs bg-brand-700 text-brand-100 px-2 py-0.5 rounded">Best</span>
                  )}
                </td>
                <td className="px-2 py-3 text-right text-gray-300">{fmt(r.avg_log_loss)}</td>
                <td className="px-2 py-3 text-right text-gray-300">{fmt(r.avg_brier)}</td>
                <td className="px-2 py-3 text-right text-gray-300">{fmt(detail.avg_roc_auc)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function Model() {
  const [tab, setTab] = useState('sport')

  const { data: multiSummary, loading: msl, error: mse } = useApi('/api/sport-summary')
  const { data: metrics,      loading: ml,  error: me  } = useApi('/api/metrics')
  const { data: benchmark,    loading: bl,  error: be  } = useApi('/api/benchmark')

  const sportSummaries = {}
  for (const s of multiSummary?.sports ?? []) {
    sportSummaries[s.sport] = s
  }
  const totalTrainingRows = (multiSummary?.sports ?? []).reduce((sum, s) => sum + (s.rows ?? 0), 0)

  const folds = metrics?.folds ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold text-gray-100">Model</h1>
        <div className="flex gap-1 bg-navy-800 border border-navy-700 rounded-lg p-1">
          {[['sport', 'Sport Models'], ['mixed', 'Mixed Model']].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-1.5 rounded-md text-sm transition-colors ${
                tab === key ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Sport-specific tab ── */}
      {tab === 'sport' && (
        <div className="space-y-6">
          {msl && <Loader />}
          {mse && (
            <div className="space-y-2">
              <ErrorBox message={`Sport models not found: ${mse}`} />
              <p className="text-xs text-gray-500">
                Run <code className="text-brand-400">python run.py sport-models</code> to train sport-specific models.
              </p>
            </div>
          )}

          {multiSummary && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {['soccer', 'nba', 'mlb'].map(sport => (
                  <SportModelCard key={sport} sport={sport} summary={sportSummaries[sport]} />
                ))}
              </div>

              {/* ROC AUC comparison bar */}
              <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
                <h2 className="text-sm text-gray-400 uppercase tracking-wider mb-4">ROC AUC by Sport</h2>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart
                    data={['soccer','nba','mlb'].map(s => ({
                      sport: SPORT_META[s]?.label ?? s,
                      roc_auc: sportSummaries[s]?.avg_roc_auc ?? 0,
                      baseline: 0.5,
                    }))}
                    margin={{ top: 5, right: 20, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="sport" tick={{ fill: '#6b7280', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} domain={[0.45, 0.7]} />
                    <Tooltip
                      contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                    />
                    <Bar dataKey="roc_auc" name="ROC AUC" radius={[6,6,0,0]}>
                      {['soccer','nba','mlb'].map(s => (
                        <Cell key={s} fill={SPORT_META[s]?.color ?? '#6b7280'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <p className="text-xs text-gray-600 mt-2">
                  0.5 = random · 0.55 = weak signal · 0.58+ = strong · 0.63+ = elite
                </p>
              </div>

              {/* Notes box */}
              <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 text-xs text-gray-500 space-y-1">
                <p className="font-semibold text-gray-400">Backtest note</p>
                <p>
                  Backtest uses a simulated 5%-vig market baseline for games without real odds.
                  Stakes capped at 0.5% for simulated games. Yield and ROI are
                  indicative only — not from real bookmaker closing lines.
                  Capture live odds daily via <code className="text-brand-400">python daily_odds_capture.py</code> to build real historical closing lines over time.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Mixed model tab ── */}
      {tab === 'mixed' && (
        <div className="space-y-6">
          {(ml || bl) && <Loader />}
          {me && <ErrorBox message={me} />}
          {be && <ErrorBox message={be} />}

          {metrics && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <Card title="Best Model"   value={benchmark?.best_model ?? '—'}       color="green" />
                <Card title="Avg Log Loss" value={fmt(metrics.avg_log_loss)}           sub="Lower is better" />
                <Card title="Avg Brier"    value={fmt(metrics.avg_brier)}              sub="Lower is better" />
                <Card title="Avg ROC AUC"  value={fmt(metrics.avg_roc_auc)}            sub="Higher is better" />
                <Card title="CV Folds"     value={folds.length}                        />
                <Card title="Training rows" value={totalTrainingRows > 0 ? totalTrainingRows.toLocaleString() : '—'} sub="Real games (soccer/NBA/MLB)" />
              </div>

              <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
                <h2 className="text-sm text-gray-400 uppercase tracking-wider mb-4">Walk-Forward Fold Metrics</h2>
                <FoldChart folds={folds} />
              </div>
            </>
          )}

          {benchmark && (
            <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
              <h2 className="text-sm text-gray-400 uppercase tracking-wider mb-4">Model Benchmark Ranking</h2>
              <BenchmarkTable benchmark={benchmark} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
