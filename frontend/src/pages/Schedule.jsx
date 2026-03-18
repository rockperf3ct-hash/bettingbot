import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'

// ── helpers ──────────────────────────────────────────────────────────────────

function pct(v, dec = 1) {
  if (v == null) return '—'
  return (Number(v) * 100).toFixed(dec) + '%'
}
function odds(v) {
  if (v == null) return '—'
  return Number(v).toFixed(2)
}
function fmtTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}
function fmtDay(dateStr) {
  if (!dateStr) return '—'
  try {
    const d = new Date(dateStr + 'T12:00:00')
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  } catch { return dateStr }
}

const TIER_STYLE = {
  Strong:   'bg-green-900/70 text-green-300 border border-green-700',
  Moderate: 'bg-yellow-900/60 text-yellow-300 border border-yellow-700',
  Lean:     'bg-gray-800 text-gray-400 border border-gray-700',
}
const SPORT_ICON = { NBA: '🏀', MLB: '⚾', EPL: '⚽', Bundesliga: '⚽', LaLiga: '⚽', 'Liga MX': '⚽', UCL: '⚽', 'Europa League': '⚽' }

function sportIcon(league) {
  return SPORT_ICON[league] || '🏟️'
}

// ── Game row card ─────────────────────────────────────────────────────────────

function GameCard({ game }) {
  const [expanded, setExpanded] = useState(false)
  const hasEdge   = game.has_edge
  const tier      = game.tier
  const betSide   = game.bet_side
  const betTeam   = game.bet_team

  const homeEdge  = game.edge_home != null ? (game.edge_home * 100).toFixed(1) : null
  const awayEdge  = game.edge_away != null ? (game.edge_away * 100).toFixed(1) : null
  const bestEdge  = game.best_edge != null ? (game.best_edge * 100).toFixed(1) : null

  const hasOdds   = game.home_odds != null || game.home_fanduel != null
  const hasSpread = game.home_spread != null
  const hasTotal  = game.total_line != null

  return (
    <div
      className={`bg-gray-900 border rounded-xl p-4 transition-colors cursor-pointer
        ${hasEdge
          ? 'border-green-800/60 hover:border-green-700'
          : 'border-gray-800 hover:border-gray-700'
        }`}
      onClick={() => setExpanded(e => !e)}
    >
      {/* Row layout */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Sport + League */}
        <div className="shrink-0 w-24 text-xs text-gray-500 text-center">
          <div className="text-base">{sportIcon(game.league)}</div>
          <div className="truncate">{game.league}</div>
        </div>

        {/* Teams + time */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-semibold ${betSide === 'home' && hasEdge ? 'text-green-300' : 'text-gray-100'}`}>
              {game.home_team}
              {betSide === 'home' && hasEdge && <span className="ml-1 text-xs text-green-400">← BET</span>}
            </span>
            <span className="text-gray-600 text-xs">vs</span>
            <span className={`text-sm font-semibold ${betSide === 'away' && hasEdge ? 'text-green-300' : 'text-gray-100'}`}>
              {game.away_team}
              {betSide === 'away' && hasEdge && <span className="ml-1 text-xs text-green-400">BET →</span>}
            </span>
          </div>
          <div className="text-xs text-gray-600 mt-0.5">
            {fmtTime(game.date)}
            {game.venue && <span className="ml-2 text-gray-700">· {game.venue}</span>}
          </div>
        </div>

        {/* Edge + Tier badge */}
        <div className="shrink-0 text-right">
          {hasEdge ? (
            <>
              <div className="text-sm font-bold text-green-400">{bestEdge}% edge</div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_STYLE[tier] || TIER_STYLE.Lean}`}>
                {tier}
              </span>
            </>
          ) : (
            <div className="text-xs text-gray-700">No edge</div>
          )}
        </div>

        {/* Quick odds pill */}
        {hasOdds && (
          <div className="shrink-0 text-xs text-gray-500 text-right space-y-0.5">
            <div>
              <span className="text-gray-400">{odds(game.home_fanduel ?? game.home_odds)}</span>
              <span className="text-gray-700 mx-1">/</span>
              <span className="text-gray-400">{odds(game.away_fanduel ?? game.away_odds)}</span>
            </div>
            {hasSpread && (
              <div className="text-gray-600">
                Spread {game.home_spread > 0 ? '+' : ''}{game.home_spread}
              </div>
            )}
            {hasTotal && (
              <div className="text-gray-600">O/U {game.total_line}</div>
            )}
          </div>
        )}

        {/* Odds source dot */}
        {game.odds_source === 'the_odds_api' && (
          <div className="shrink-0 w-2 h-2 rounded-full bg-green-500" title="Live odds" />
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-4 pt-4 border-t border-gray-800 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          {/* Model scores */}
          <div className="space-y-1.5">
            <p className="text-gray-500 font-semibold uppercase tracking-wide">Model Prediction</p>
            <div className="flex justify-between">
              <span className="text-gray-400">{game.home_team?.split(' ').slice(-1)[0]}</span>
              <span className={`font-bold ${betSide === 'home' && hasEdge ? 'text-green-400' : 'text-gray-300'}`}>
                {pct(game.model_prob_home)} ({homeEdge != null ? (Number(homeEdge) > 0 ? '+' : '') + homeEdge + '%' : '—'})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">{game.away_team?.split(' ').slice(-1)[0]}</span>
              <span className={`font-bold ${betSide === 'away' && hasEdge ? 'text-green-400' : 'text-gray-300'}`}>
                {pct(game.model_prob_away)} ({awayEdge != null ? (Number(awayEdge) > 0 ? '+' : '') + awayEdge + '%' : '—'})
              </span>
            </div>
            <p className="text-gray-700 pt-1">Edge = model prob − de-vigged implied</p>
          </div>

          {/* Moneyline */}
          <div className="space-y-1.5">
            <p className="text-gray-500 font-semibold uppercase tracking-wide">Moneyline</p>
            {game.home_fanduel != null && (
              <div className="flex justify-between">
                <span className="text-gray-500">FanDuel</span>
                <span className="text-gray-300">{odds(game.home_fanduel)} / {odds(game.away_fanduel)}</span>
              </div>
            )}
            {game.home_draftkings != null && (
              <div className="flex justify-between">
                <span className="text-gray-500">DraftKings</span>
                <span className="text-gray-300">{odds(game.home_draftkings)} / {odds(game.away_draftkings)}</span>
              </div>
            )}
            {!game.home_fanduel && !game.home_draftkings && (
              <p className="text-gray-700">No live odds yet — check closer to game time</p>
            )}
          </div>

          {/* Spread + Total */}
          <div className="space-y-1.5">
            <p className="text-gray-500 font-semibold uppercase tracking-wide">Spread & Total</p>
            {hasSpread ? (
              <>
                <div className="flex justify-between">
                  <span className="text-gray-400">{game.home_team?.split(' ').slice(-1)[0]}</span>
                  <span className="text-gray-300">
                    {game.home_spread > 0 ? '+' : ''}{game.home_spread}
                    {game.home_spread_odds && <span className="text-gray-500 ml-1">({odds(game.home_spread_odds)})</span>}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">{game.away_team?.split(' ').slice(-1)[0]}</span>
                  <span className="text-gray-300">
                    {game.away_spread > 0 ? '+' : ''}{game.away_spread}
                    {game.away_spread_odds && <span className="text-gray-500 ml-1">({odds(game.away_spread_odds)})</span>}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-gray-700">No spread data yet</p>
            )}
            {hasTotal && (
              <div className="flex justify-between pt-1 border-t border-gray-800/60">
                <span className="text-gray-400">Total O/U {game.total_line}</span>
                <span className="text-gray-300">
                  O {odds(game.over_odds)} / U {odds(game.under_odds)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Filters bar ───────────────────────────────────────────────────────────────

const SPORT_FILTERS = ['All', 'Soccer', 'NBA', 'MLB']
const DAY_OPTIONS   = [3, 7, 10, 14]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Schedule() {
  const [days, setDays]           = useState(7)
  const [sportFilter, setSport]   = useState('All')
  const [onlyEdge, setOnlyEdge]   = useState(false)
  const [search, setSearch]       = useState('')
  const [expandAll, setExpandAll] = useState(false)

  const { data, loading, error, refetch } = useApi(`/api/schedule?days=${days}&with_scores=true`)

  const allGames = data?.games ?? []

  // Apply filters
  const filtered = allGames.filter(g => {
    if (onlyEdge && !g.has_edge) return false
    if (sportFilter === 'Soccer' && ['NBA', 'MLB'].includes(g.league)) return false
    if (sportFilter === 'NBA'    && g.league !== 'NBA')   return false
    if (sportFilter === 'MLB'    && g.league !== 'MLB')   return false
    if (search) {
      const q = search.toLowerCase()
      if (!g.home_team?.toLowerCase().includes(q) && !g.away_team?.toLowerCase().includes(q) && !g.league?.toLowerCase().includes(q)) return false
    }
    return true
  })

  // Group filtered by date
  const byDate = {}
  for (const g of filtered) {
    const day = (g.date || '').slice(0, 10)
    if (!byDate[day]) byDate[day] = []
    byDate[day].push(g)
  }
  const sortedDays = Object.keys(byDate).sort()

  // Stats
  const totalEdge    = allGames.filter(g => g.has_edge).length
  const totalNoOdds  = allGames.filter(g => !g.home_odds && !g.home_fanduel).length

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Schedule</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Next {days} days · {allGames.length} games · {totalEdge} with model edge
            {totalNoOdds > 0 && <span className="text-gray-700 ml-2">· {totalNoOdds} awaiting odds</span>}
          </p>
        </div>
        <button
          onClick={refetch}
          disabled={loading}
          className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded-lg px-3 py-2 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Days ahead */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          {DAY_OPTIONS.map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-1 rounded-md text-xs transition-colors ${
                days === d ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}>
              {d}d
            </button>
          ))}
        </div>

        {/* Sport filter */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          {SPORT_FILTERS.map(s => (
            <button key={s} onClick={() => setSport(s)}
              className={`px-3 py-1 rounded-md text-xs transition-colors ${
                sportFilter === s ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}>
              {s}
            </button>
          ))}
        </div>

        {/* Edge only toggle */}
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
          <input
            type="checkbox"
            checked={onlyEdge}
            onChange={e => setOnlyEdge(e.target.checked)}
            className="w-3.5 h-3.5 accent-green-500"
          />
          Edge bets only
        </label>

        {/* Search */}
        <input
          type="text"
          placeholder="Search team or league…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-300 px-3 py-2 w-44 focus:outline-none"
        />

        <span className="ml-auto text-xs text-gray-600">{filtered.length} games shown</span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500" /> Live odds available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded-full bg-green-900/70 text-green-300 border border-green-700 text-xs">Strong</span>
          ≥8% edge
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded-full bg-yellow-900/60 text-yellow-300 border border-yellow-700 text-xs">Moderate</span>
          5–8% edge
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 text-xs">Lean</span>
          3–5% edge
        </span>
        <span>Click a game to expand odds + model breakdown</span>
      </div>

      {loading && <Loader />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <p className="text-4xl mb-3">📅</p>
          <p className="text-sm">No games match your filters.</p>
          <p className="text-xs mt-1 text-gray-600">Try a wider date range or removing filters.</p>
        </div>
      )}

      {/* Games grouped by day */}
      <div className="space-y-6">
        {sortedDays.map(day => (
          <div key={day}>
            {/* Day header */}
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-sm font-semibold text-gray-300">{fmtDay(day)}</h2>
              <span className="text-xs text-gray-600">{byDate[day].length} games</span>
              <div className="flex-1 h-px bg-gray-800" />
              {byDate[day].filter(g => g.has_edge).length > 0 && (
                <span className="text-xs text-green-500 font-medium">
                  {byDate[day].filter(g => g.has_edge).length} value bet{byDate[day].filter(g => g.has_edge).length > 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Game cards */}
            <div className="space-y-2">
              {byDate[day].map((game, i) => (
                <GameCard key={`${game.home_team}-${game.away_team}-${i}`} game={game} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-700 text-center pb-2">
        Schedule from ESPN + MLB Stats API (free). Live odds from The Odds API.
        Model edge is directional — not a guarantee of profit. Bet responsibly.
      </p>
    </div>
  )
}
