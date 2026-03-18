/**
 * Dashboard — FanDuel-style game slate.
 * Shows today's + upcoming games grouped by sport/league.
 * Each game has odds buttons. Clicking adds to the bet slip.
 */
import { useState, useMemo } from 'react'
import { useApi } from '../hooks/useApi'
import { useBetSlip } from '../App'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'

const API = 'http://localhost:8000'

const SPORT_META = {
  soccer: { icon: '⚽', label: 'Soccer',     order: 1 },
  nba:    { icon: '🏀', label: 'Basketball',  order: 2 },
  mlb:    { icon: '⚾', label: 'Baseball',    order: 3 },
}
const LEAGUE_PRIORITY = {
  UCL: 0, 'Europa League': 1, EPL: 2, Bundesliga: 3,
  LaLiga: 4, 'Liga MX': 5, NBA: 6, MLB: 7,
}

const TIER_STYLE = {
  Strong:   'stat-chip green',
  Moderate: 'stat-chip yellow',
  Lean:     'stat-chip gray',
}

function toAmerican(dec) {
  if (!dec || dec <= 1) return null
  return dec >= 2
    ? '+' + Math.round((dec - 1) * 100)
    : '-' + Math.round(100 / (dec - 1))
}

function formatTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function formatDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const today = new Date()
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1)
    if (d.toDateString() === today.toDateString())    return 'Today'
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  } catch { return '' }
}

// ---------------------------------------------------------------------------
// Odds button
// ---------------------------------------------------------------------------
function OddsBtn({ label, sublabel, odds, onClick, selected, dim }) {
  const american = toAmerican(odds)
  return (
    <button
      onClick={onClick}
      disabled={!odds || dim}
      className={`odds-btn min-w-[72px] ${selected ? 'selected' : ''} ${!odds || dim ? 'opacity-30 cursor-default' : ''}`}
    >
      <span className="text-xs text-gray-400 font-medium truncate max-w-full">{label}</span>
      <span className="text-sm font-bold mt-0.5">
        {american || (odds ? odds.toFixed(2) : '—')}
      </span>
      {sublabel && <span className="text-xs text-gray-500 mt-0.5">{sublabel}</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Single game row
// ---------------------------------------------------------------------------
function GameRow({ game, selectedBets, onSelect }) {
  const isSelected = (side) =>
    selectedBets.some(b =>
      b.home_team === game.home_team &&
      b.away_team === game.away_team &&
      b.bet_side === side
    )

  const makeBet = (side, odds, betType = 'moneyline', label = '') => ({
    home_team:     game.home_team,
    away_team:     game.away_team,
    bet_side:      side,
    bet_team:      side === 'home' ? game.home_team : side === 'away' ? game.away_team : 'Draw',
    bet_type:      betType,
    bet_type_label: label || betType,
    league:        game.league || '',
    sport:         game.sport  || '',
    odds,
    model_prob:    side === 'home' ? game.model_prob_home : game.model_prob,
    edge:          game.edge,
    notes:         '',
  })

  const statusFinal = ['STATUS_FINAL','STATUS_FULL_TIME','STATUS_FINAL_AET','STATUS_FINAL_PEN'].includes(game.status)

  return (
    <div className={`game-card ${statusFinal ? 'opacity-50' : ''}`}>
      {/* Top bar: time + league + tier badge */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-navy-700/60">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>{formatDate(game.game_date || game.commence_time)}</span>
          {(game.game_date || game.commence_time) && <span>·</span>}
          <span>{formatTime(game.game_date || game.commence_time)}</span>
          <span>·</span>
          <span className="text-gray-400">{game.league}</span>
        </div>
        <div className="flex items-center gap-2">
          {game.tier && (
            <span className={TIER_STYLE[game.tier] || 'stat-chip gray'}>
              {game.tier}
            </span>
          )}
          {game.edge != null && Math.abs(game.edge) >= 0.05 && (
            <span className="stat-chip blue">
              {(game.edge * 100).toFixed(1)}% edge
            </span>
          )}
          {game.odds_source === 'the_odds_api' && (
            <span className="stat-chip green text-xs">Live odds</span>
          )}
        </div>
      </div>

      {/* Teams + odds */}
      <div className="px-4 py-3 space-y-2">
        {/* Away team */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-100 truncate">{game.away_team}</p>
              {game.away_form != null && (
                <p className="text-xs text-gray-600">Avg {game.away_form.toFixed(1)}/g (last 5)</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Spread */}
            {game.away_spread != null && (
              <OddsBtn
                label={game.away_spread > 0 ? `+${game.away_spread}` : `${game.away_spread}`}
                odds={game.away_spread_odds}
                selected={isSelected('away_spread')}
                onClick={() => onSelect(makeBet('away_spread', game.away_spread_odds, 'spread', 'Spread'))}
              />
            )}
            {/* Moneyline */}
            <OddsBtn
              label={game.away_team?.split(' ').pop()}
              odds={game.away_odds}
              selected={isSelected('away')}
              onClick={() => onSelect(makeBet('away', game.away_odds, 'moneyline', 'Moneyline'))}
            />
          </div>
        </div>

        {/* Home team */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-100 truncate">{game.home_team}</p>
              {game.home_form != null && (
                <p className="text-xs text-gray-600">Avg {game.home_form.toFixed(1)}/g (last 5)</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Spread */}
            {game.home_spread != null && (
              <OddsBtn
                label={game.home_spread > 0 ? `+${game.home_spread}` : `${game.home_spread}`}
                odds={game.home_spread_odds}
                selected={isSelected('home_spread')}
                onClick={() => onSelect(makeBet('home_spread', game.home_spread_odds, 'spread', 'Spread'))}
              />
            )}
            {/* Moneyline */}
            <OddsBtn
              label={game.home_team?.split(' ').pop()}
              odds={game.home_odds}
              selected={isSelected('home')}
              onClick={() => onSelect(makeBet('home', game.home_odds, 'moneyline', 'Moneyline'))}
            />
          </div>
        </div>

        {/* Draw + Totals row */}
        {(game.draw_odds || game.total_line) && (
          <div className="flex items-center gap-2 pt-1 border-t border-navy-700/40">
            {game.draw_odds && (
              <OddsBtn
                label="Draw"
                odds={game.draw_odds}
                selected={isSelected('draw')}
                onClick={() => onSelect(makeBet('draw', game.draw_odds, 'draw', 'Draw'))}
              />
            )}
            {game.total_line && (
              <>
                <OddsBtn
                  label={`O ${game.total_line}`}
                  odds={game.over_odds}
                  selected={isSelected('over')}
                  onClick={() => onSelect(makeBet('over', game.over_odds, 'total_over', `Over ${game.total_line}`))}
                />
                <OddsBtn
                  label={`U ${game.total_line}`}
                  odds={game.under_odds}
                  selected={isSelected('under')}
                  onClick={() => onSelect(makeBet('under', game.under_odds, 'total_under', `Under ${game.total_line}`))}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// League section
// ---------------------------------------------------------------------------
function LeagueSection({ league, games, selectedBets, onSelect }) {
  const [collapsed, setCollapsed] = useState(false)
  const sport = games[0]?.sport || 'soccer'
  const icon = SPORT_META[sport]?.icon || '🎮'

  return (
    <div>
      <button
        className="section-header w-full text-left gap-2 hover:bg-navy-800/60 transition-colors"
        onClick={() => setCollapsed(c => !c)}
      >
        <span>{icon}</span>
        <span>{league}</span>
        <span className="text-gray-600 font-normal normal-case tracking-normal ml-1">
          {games.length} game{games.length !== 1 ? 's' : ''}
        </span>
        <span className="ml-auto text-gray-600">{collapsed ? '▼' : '▲'}</span>
      </button>
      {!collapsed && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 p-3 bg-navy-950/30">
          {games.map((g, i) => (
            <GameRow
              key={i}
              game={g}
              selectedBets={selectedBets}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------
export default function Dashboard() {
  const [sportFilter, setSportFilter] = useState('all')
  const [dayFilter, setDayFilter]     = useState('today')
  const { addBet, slip } = useBetSlip()

  // Fetch scheduled games with ML scores + odds
  const days = dayFilter === 'today' ? 1 : dayFilter === 'tomorrow' ? 2 : 7
  const { data, loading, error } = useApi(
    `${API}/api/schedule?days=${days}&with_scores=true`,
    { interval: 120000 }  // refresh every 2 min
  )

  // Quick stats from tracker
  const { data: stats } = useApi(`${API}/api/tracker/summary`)

  const games = useMemo(() => {
    let gs = data?.games ?? []

    // Filter out finished
    const DONE = ['STATUS_FINAL','STATUS_FULL_TIME','STATUS_FINAL_AET','STATUS_FINAL_PEN','STATUS_POSTPONED']
    gs = gs.filter(g => !DONE.includes(g.status))

    // Day filter — field is 'date' (ISO string), not 'game_date'
    if (dayFilter === 'today') {
      const today = new Date().toISOString().slice(0, 10)
      gs = gs.filter(g => (g.date || '').startsWith(today))
    } else if (dayFilter === 'tomorrow') {
      const tmr = new Date(); tmr.setDate(tmr.getDate() + 1)
      const tmrStr = tmr.toISOString().slice(0, 10)
      gs = gs.filter(g => (g.date || '').startsWith(tmrStr))
    }

    // Sport filter
    if (sportFilter !== 'all') {
      if (sportFilter === 'soccer') gs = gs.filter(g => g.sport === 'soccer')
      if (sportFilter === 'nba')    gs = gs.filter(g => g.league === 'NBA')
      if (sportFilter === 'mlb')    gs = gs.filter(g => g.league === 'MLB')
    }

    return gs
  }, [data, sportFilter, dayFilter])

  // Group by league, sorted by priority
  const byLeague = useMemo(() => {
    const m = {}
    games.forEach(g => {
      const lg = g.league || 'Other'
      if (!m[lg]) m[lg] = []
      m[lg].push(g)
    })
    return Object.entries(m).sort(([a], [b]) =>
      (LEAGUE_PRIORITY[a] ?? 99) - (LEAGUE_PRIORITY[b] ?? 99)
    )
  }, [games])

  const handleSelect = (bet) => addBet(bet)

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Game Slate</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Pre-game odds · ML edge scores · Click odds to add to slip
          </p>
        </div>

        {/* Quick stats strip */}
        {stats && (
          <div className="flex items-center gap-4 text-xs">
            <div className="text-center">
              <p className="text-gray-400 font-semibold">{stats.pending ?? 0}</p>
              <p className="text-gray-600">Pending</p>
            </div>
            <div className="text-center">
              <p className={stats.total_pnl >= 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                {stats.total_pnl != null ? (stats.total_pnl >= 0 ? '+' : '') + '$' + Math.abs(stats.total_pnl).toFixed(2) : '—'}
              </p>
              <p className="text-gray-600">P&L</p>
            </div>
            <div className="text-center">
              <p className="text-gray-400 font-semibold">
                {stats.hit_rate != null ? (stats.hit_rate * 100).toFixed(1) + '%' : '—'}
              </p>
              <p className="text-gray-600">Hit Rate</p>
            </div>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Day filter */}
        <div className="flex bg-navy-800 border border-navy-700 rounded-lg p-0.5 gap-0.5">
          {[['today','Today'],['tomorrow','Tomorrow'],['week','This Week']].map(([v,l]) => (
            <button
              key={v}
              onClick={() => setDayFilter(v)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                dayFilter === v
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Sport filter */}
        <div className="flex bg-navy-800 border border-navy-700 rounded-lg p-0.5 gap-0.5">
          {[['all','All'],['soccer','⚽'],['nba','🏀'],['mlb','⚾']].map(([v,l]) => (
            <button
              key={v}
              onClick={() => setSportFilter(v)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                sportFilter === v
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        <span className="text-xs text-gray-600 ml-2">
          {games.length} game{games.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Games */}
      {loading && <Loader />}
      {error && <ErrorBox message={error} />}

      {!loading && byLeague.length === 0 && (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-12 text-center">
          <p className="text-gray-500 text-sm">No games scheduled for this filter.</p>
          <p className="text-gray-600 text-xs mt-1">Try switching to "Tomorrow" or "This Week".</p>
        </div>
      )}

      <div className="bg-navy-900 border border-navy-700 rounded-xl overflow-hidden divide-y divide-navy-700">
        {byLeague.map(([league, lgGames]) => (
          <LeagueSection
            key={league}
            league={league}
            games={lgGames}
            selectedBets={slip}
            onSelect={handleSelect}
          />
        ))}
      </div>

      <p className="text-xs text-gray-700 text-center">
        Odds from The Odds API (FanDuel/DraftKings). Pre-game only. Refreshes every 2 min.
      </p>
    </div>
  )
}
