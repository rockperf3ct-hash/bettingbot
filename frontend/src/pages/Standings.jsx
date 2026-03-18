import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'

function usePreseason(active) {
  return useApi(active ? '/api/standings/mlb-preseason' : null)
}

const LEAGUES = [
  { slug: 'epl',        label: 'EPL',         flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { slug: 'bundesliga', label: 'Bundesliga',   flag: '🇩🇪' },
  { slug: 'laliga',     label: 'La Liga',      flag: '🇪🇸' },
  { slug: 'liga_mx',    label: 'Liga MX',      flag: '🇲🇽' },
  { slug: 'ucl',        label: 'UCL',          flag: '⭐' },
  { slug: 'europa',     label: 'Europa Lg',    flag: '🟠' },
  { slug: 'nba',        label: 'NBA',          flag: '🏀' },
  { slug: 'mlb',        label: 'MLB',          flag: '⚾' },
]

function rankBadge(rank) {
  if (!rank) return null
  const r = Number(rank)
  if (r === 1) return <span className="text-yellow-400 font-bold">1</span>
  if (r === 2) return <span className="text-gray-300 font-bold">2</span>
  if (r === 3) return <span className="text-amber-600 font-bold">3</span>
  return <span className="text-gray-500">{r}</span>
}

function pct(val) {
  if (val == null) return '—'
  return (Number(val) * 100).toFixed(1) + '%'
}

function num(val, dec = 0) {
  if (val == null) return '—'
  return Number(val).toFixed(dec)
}

function gdColor(val) {
  if (val == null) return 'text-gray-400'
  return Number(val) > 0 ? 'text-green-400' : Number(val) < 0 ? 'text-red-400' : 'text-gray-400'
}

// Soccer table — has pts, W/D/L, GF/GA, GD
function SoccerTable({ rows, loading, error }) {
  if (loading) return <Loader />
  if (error)   return <ErrorBox message={error} />
  if (!rows?.length) return <p className="text-gray-500 text-sm py-6 text-center">No standings data available.</p>

  // Sort by rank if available, else by points descending
  const sorted = [...rows].sort((a, b) => {
    if (a.standing_rank != null && b.standing_rank != null) return a.standing_rank - b.standing_rank
    return (b.standing_points ?? 0) - (a.standing_points ?? 0)
  })

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-navy-700">
            <th className="pb-3 text-left w-8">#</th>
            <th className="pb-3 text-left">Team</th>
            <th className="pb-3 text-right">P</th>
            <th className="pb-3 text-right">W</th>
            <th className="pb-3 text-right">D</th>
            <th className="pb-3 text-right">L</th>
            <th className="pb-3 text-right">GF</th>
            <th className="pb-3 text-right">GA</th>
            <th className="pb-3 text-right">GD</th>
            <th className="pb-3 text-right">Pts</th>
            <th className="pb-3 text-right">Win%</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-700/50">
          {sorted.map((row, i) => (
            <tr
              key={row.team_name + i}
              className={`transition-colors ${i < 4 ? 'bg-blue-950/20' : i >= sorted.length - 3 ? 'bg-red-950/20' : 'bg-navy-900'}`}
            >
              <td className="py-2.5 pr-3">{rankBadge(row.standing_rank ?? i + 1)}</td>
              <td className="py-2.5 font-medium text-gray-100">{row.team_name}</td>
              <td className="py-2.5 text-right text-gray-400">{num(row.standing_played)}</td>
              <td className="py-2.5 text-right text-gray-300">{num(row.standing_wins)}</td>
              <td className="py-2.5 text-right text-gray-400">{num(row.standing_draws)}</td>
              <td className="py-2.5 text-right text-gray-400">{num(row.standing_losses)}</td>
              <td className="py-2.5 text-right text-gray-300">{num(row.standing_gf)}</td>
              <td className="py-2.5 text-right text-gray-400">{num(row.standing_ga)}</td>
              <td className={`py-2.5 text-right font-medium ${gdColor(row.standing_gd)}`}>
                {row.standing_gd != null && Number(row.standing_gd) > 0 ? '+' : ''}{num(row.standing_gd)}
              </td>
              <td className="py-2.5 text-right font-bold text-gray-100">{num(row.standing_points)}</td>
              <td className="py-2.5 text-right text-gray-500">{pct(row.standing_win_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-gray-600 mt-3">Blue = Top 4 (Champions League) · Red = Relegation zone</p>
    </div>
  )
}

// NBA table — has W/L, win%, pts for/against
function NbaTable({ rows, loading, error }) {
  if (loading) return <Loader />
  if (error)   return <ErrorBox message={error} />
  if (!rows?.length) return <p className="text-gray-500 text-sm py-6 text-center">No standings data available.</p>

  // Split into conferences by group field, sort each best→worst
  const conferences = {}
  for (const r of rows) {
    const grp = r.group || 'League'
    if (!conferences[grp]) conferences[grp] = []
    conferences[grp].push(r)
  }
  // Sort each conference best → worst by win%
  for (const grp of Object.keys(conferences)) {
    conferences[grp].sort((a, b) => (b.standing_win_pct ?? 0) - (a.standing_win_pct ?? 0))
  }

  return (
    <div className="space-y-6">
      {Object.entries(conferences).map(([conf, confRows]) => (
        <div key={conf}>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{conf}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-navy-700">
                  <th className="pb-3 text-left w-8">#</th>
                  <th className="pb-3 text-left">Team</th>
                  <th className="pb-3 text-right">W</th>
                  <th className="pb-3 text-right">L</th>
                  <th className="pb-3 text-right">Win%</th>
                  <th className="pb-3 text-right">PPG</th>
                  <th className="pb-3 text-right">OPP PPG</th>
                  <th className="pb-3 text-right">Diff</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-700/50">
                {confRows.map((row, i) => {
                  const gp = (row.standing_wins ?? 0) + (row.standing_losses ?? 0) || 1
                  const ppg = row.standing_gf != null ? row.standing_gf / gp : null
                  const oppg = row.standing_ga != null ? row.standing_ga / gp : null
                  const diff = ppg != null && oppg != null ? ppg - oppg : null
                  return (
                    <tr key={row.team_name + i} className={i < 6 ? 'bg-blue-950/20' : 'bg-navy-900'}>
                      <td className="py-2.5 pr-3">{rankBadge(i + 1)}</td>
                      <td className="py-2.5 font-medium text-gray-100">{row.team_name}</td>
                      <td className="py-2.5 text-right text-gray-300">{num(row.standing_wins)}</td>
                      <td className="py-2.5 text-right text-gray-400">{num(row.standing_losses)}</td>
                      <td className="py-2.5 text-right text-gray-200 font-medium">{pct(row.standing_win_pct)}</td>
                      <td className="py-2.5 text-right text-gray-400">{ppg != null ? num(ppg, 1) : '—'}</td>
                      <td className="py-2.5 text-right text-gray-400">{oppg != null ? num(oppg, 1) : '—'}</td>
                      <td className={`py-2.5 text-right font-medium ${gdColor(diff)}`}>
                        {diff != null ? (diff > 0 ? '+' : '') + num(diff, 1) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-600 mt-2">Blue = Playoff spots (top 6)</p>
        </div>
      ))}
    </div>
  )
}

// MLB table — AL/NL or Cactus/Grapefruit League, W/L/Win%/GB/Streak/Home/Road
function MlbTable({ rows, loading, error, isPreseason = false }) {
  if (loading) return <Loader />
  if (error)   return <ErrorBox message={error} />
  if (!rows?.length) return <p className="text-gray-500 text-sm py-6 text-center">No standings data available.</p>

  // Split by AL / NL
  const leagues = {}
  for (const r of rows) {
    const grp = r.group || 'League'
    if (!leagues[grp]) leagues[grp] = []
    leagues[grp].push(r)
  }
  // Sort each league best → worst by win%
  for (const grp of Object.keys(leagues)) {
    leagues[grp].sort((a, b) => (b.standing_win_pct ?? 0) - (a.standing_win_pct ?? 0))
  }

  function streakLabel(val) {
    if (val == null || val === '') return '—'
    // Handle string format like "W3" or "L2" from ESPN
    if (typeof val === 'string') {
      const m = val.match(/^([WLwl])(\d+)$/)
      if (m) {
        const isWin = m[1].toUpperCase() === 'W'
        return isWin
          ? <span className="text-green-400">W{m[2]}</span>
          : <span className="text-red-400">L{m[2]}</span>
      }
    }
    // Handle numeric format: positive = win streak, negative = loss streak
    const n = Number(val)
    if (isNaN(n) || n === 0) return '—'
    if (n > 0) return <span className="text-green-400">W{n}</span>
    return <span className="text-red-400">L{Math.abs(n)}</span>
  }

  return (
    <div className="space-y-6">
      {Object.entries(leagues).map(([league, leagueRows]) => (
        <div key={league}>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{league}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-navy-700">
                  <th className="pb-3 text-left w-8">#</th>
                  <th className="pb-3 text-left">Team</th>
                  <th className="pb-3 text-right">W</th>
                  <th className="pb-3 text-right">L</th>
                  <th className="pb-3 text-right">Win%</th>
                  <th className="pb-3 text-right">GB</th>
                  <th className="pb-3 text-right">Home</th>
                  <th className="pb-3 text-right">Road</th>
                  <th className="pb-3 text-right">Streak</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-700/50">
                {leagueRows.map((row, i) => (
                  <tr key={row.team_name + i} className={i < 3 ? 'bg-blue-950/20' : i < 6 ? 'bg-blue-950/10' : 'bg-navy-900'}>
                    <td className="py-2.5 pr-3">{rankBadge(i + 1)}</td>
                    <td className="py-2.5 font-medium text-gray-100 flex items-center gap-2">
                      {row.team_logo && (
                        <img src={row.team_logo} alt="" className="w-5 h-5 object-contain" />
                      )}
                      {row.team_name}
                    </td>
                    <td className="py-2.5 text-right text-gray-300">{num(row.standing_wins)}</td>
                    <td className="py-2.5 text-right text-gray-400">{num(row.standing_losses)}</td>
                    <td className="py-2.5 text-right text-gray-200 font-medium">{pct(row.standing_win_pct)}</td>
                    <td className="py-2.5 text-right text-gray-500">
                      {row.standing_gb != null ? (Number(row.standing_gb) === 0 ? '—' : num(row.standing_gb, 1)) : '—'}
                    </td>
                    <td className="py-2.5 text-right text-gray-400 text-xs">
                      {row.standing_home_w != null ? `${num(row.standing_home_w)}-${num(row.standing_home_l)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right text-gray-400 text-xs">
                      {row.standing_road_w != null ? `${num(row.standing_road_w)}-${num(row.standing_road_l)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right text-xs font-semibold">
                      {streakLabel(row.standing_streak)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            {isPreseason
              ? 'Spring Training · Results do not count toward regular season'
              : 'Blue = Division leaders / Wild card spots'}
          </p>
        </div>
      ))}
    </div>
  )
}

export default function Standings() {
  const [activeLeague, setActiveLeague] = useState('epl')

  const { data, loading, error, refetch } = useApi(`/api/standings/${activeLeague}`)
  const rows = data?.standings ?? []
  const isNba = activeLeague === 'nba'
  const isMlb = activeLeague === 'mlb'

  // Extra fetch for MLB Spring Training — only when MLB tab is active
  const {
    data: preData,
    loading: preLoading,
    error: preError,
  } = usePreseason(isMlb)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-100">Standings</h1>
        <button
          onClick={refetch}
          className="text-xs text-gray-500 hover:text-gray-300 border border-navy-600 rounded-lg px-3 py-2"
        >
          Refresh
        </button>
      </div>

      {/* League tabs */}
      <div className="flex flex-wrap gap-2">
        {LEAGUES.map(({ slug, label, flag }) => (
          <button
            key={slug}
            onClick={() => setActiveLeague(slug)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              activeLeague === slug
                ? 'bg-brand-600 border-brand-500 text-white'
                : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200 hover:border-navy-500'
            }`}
          >
            <span>{flag}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Source note */}
      <p className="text-xs text-gray-600">
        Live data via ESPN Standings API · No API key required · Updates in real time
        {isMlb && ' · Regular season 2026 (not yet started) · Spring Training live'}
      </p>

      {/* Table */}
      {isMlb ? (
        <div className="space-y-5">
          {/* Spring Training section */}
          <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <h2 className="text-sm text-gray-400 uppercase tracking-wider">
                ⚾ MLB Spring Training 2026
              </h2>
              <span className="text-xs bg-green-900/50 border border-green-700/50 text-green-400 px-2 py-0.5 rounded-full font-medium">
                LIVE NOW
              </span>
              {preData?.total
                ? <span className="text-gray-600 text-xs font-normal ml-1">({preData.total} teams)</span>
                : null}
            </div>
            <MlbTable
              rows={preData?.standings ?? []}
              loading={preLoading}
              error={preError}
              isPreseason
            />
          </div>

          {/* Regular season section */}
          <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <h2 className="text-sm text-gray-400 uppercase tracking-wider">
                ⚾ MLB Regular Season 2026
              </h2>
              <span className="text-xs bg-navy-700 border border-navy-600 text-gray-500 px-2 py-0.5 rounded-full font-medium">
                STARTS APR 2026
              </span>
              {data?.total
                ? <span className="text-gray-600 text-xs font-normal ml-1">({data.total} teams)</span>
                : null}
            </div>
            <MlbTable rows={rows} loading={loading} error={error} />
          </div>
        </div>
      ) : (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-5">
          <h2 className="text-sm text-gray-400 uppercase tracking-wider mb-4">
            {LEAGUES.find(l => l.slug === activeLeague)?.flag}{' '}
            {LEAGUES.find(l => l.slug === activeLeague)?.label} Standings
            {data?.total ? <span className="text-gray-600 font-normal ml-2">({data.total} teams)</span> : null}
          </h2>
          {isNba
            ? <NbaTable rows={rows} loading={loading} error={error} />
            : <SoccerTable rows={rows} loading={loading} error={error} />
          }
        </div>
      )}

      {/* Model feature note */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 text-xs text-gray-500 space-y-1">
        <p className="font-semibold text-gray-400">How standings feed the model</p>
        <p>Current table position is joined to each game before feature engineering, producing 4 model features:</p>
        <ul className="list-disc list-inside space-y-0.5 mt-1">
          <li><code className="text-brand-400">standing_rank_diff</code> — away rank − home rank (positive = home team is higher)</li>
          <li><code className="text-brand-400">standing_win_pct_diff</code> — home win% − away win%</li>
          <li><code className="text-brand-400">standing_gd_diff</code> — home goal diff − away goal diff</li>
          <li><code className="text-brand-400">standing_pts_diff</code> — home points − away points (soccer only)</li>
        </ul>
      </div>
    </div>
  )
}
