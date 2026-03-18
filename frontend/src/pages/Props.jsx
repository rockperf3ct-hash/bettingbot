/**
 * Props page — NBA player props + Soccer alternate markets.
 *
 * NBA: Points / Rebounds / Assists O/U per player, FanDuel + DraftKings.
 * Soccer: BTTS, Draw No Bet, Player Goal Scorers (anytime).
 *
 * Note: Corners and Cards require a paid Odds API plan — not available on free tier.
 */
import { useState, useEffect, useRef, useMemo, Component } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'
import { useBetSlip } from '../App'

const API_BASE = import.meta.env.VITE_API_BASE || ''

// Soccer sport-key options
const SOCCER_SPORT_KEYS = [
  { key: 'soccer_uefa_champs_league', label: 'Champions League' },
  { key: 'soccer_epl',                label: 'Premier League' },
  { key: 'soccer_germany_bundesliga', label: 'Bundesliga' },
  { key: 'soccer_spain_la_liga',      label: 'La Liga' },
  { key: 'soccer_mexico_ligamx',      label: 'Liga MX' },
  { key: 'soccer_uefa_europa_league', label: 'Europa League' },
]

const MARKET_COLORS = {
  player_points:                  'text-yellow-400',
  player_rebounds:                'text-blue-400',
  player_assists:                 'text-purple-400',
  player_threes:                  'text-green-400',
  player_steals:                  'text-red-400',
  player_blocks:                  'text-orange-400',
  player_points_rebounds_assists: 'text-cyan-400',
  player_points_rebounds:         'text-teal-400',
  player_points_assists:          'text-indigo-400',
  player_rebounds_assists:        'text-pink-400',
}
const MARKET_BG = {
  player_points:                  'bg-yellow-900/30 border-yellow-800/60',
  player_rebounds:                'bg-blue-900/30 border-blue-800/60',
  player_assists:                 'bg-purple-900/30 border-purple-800/60',
  player_threes:                  'bg-green-900/30 border-green-800/60',
  player_steals:                  'bg-red-900/30 border-red-800/60',
  player_blocks:                  'bg-orange-900/30 border-orange-800/60',
  player_points_rebounds_assists: 'bg-cyan-900/30 border-cyan-800/60',
  player_points_rebounds:         'bg-teal-900/30 border-teal-800/60',
  player_points_assists:          'bg-indigo-900/30 border-indigo-800/60',
  player_rebounds_assists:        'bg-pink-900/30 border-pink-800/60',
}

const MARKET_LABELS = {
  player_points:                  '🏀 Points',
  player_rebounds:                '🔄 Rebounds',
  player_assists:                 '✋ Assists',
  player_threes:                  '🎯 3-Pointers',
  player_steals:                  '🤚 Steals',
  player_blocks:                  '🛡️ Blocks',
  player_points_rebounds_assists: '📊 PRA',
  player_points_rebounds:         '📊 Pts+Reb',
  player_points_assists:          '📊 Pts+Ast',
  player_rebounds_assists:        '📊 Reb+Ast',
}

function fmt2(n) { return n == null ? '—' : Number(n).toFixed(2) }

// ---------------------------------------------------------------------------
// Odds comparison cell
// ---------------------------------------------------------------------------
function OddsCell({ label, over, under, line, highlight }) {
  if (!over && !under) return (
    <div className="text-center text-gray-700 text-xs">—</div>
  )
  return (
    <div className={`text-center text-xs rounded px-1 py-0.5 ${highlight ? 'ring-1 ring-green-600 bg-green-900/20' : ''}`}>
      <div className="text-gray-500 font-medium mb-0.5">{label}</div>
      <div className="flex items-center justify-center gap-1 text-[11px]">
        <span className={over ? 'text-green-400 font-semibold' : 'text-gray-600'}>
          O {fmt2(over)}
        </span>
        <span className="text-gray-700">/</span>
        <span className={under ? 'text-red-400 font-semibold' : 'text-gray-600'}>
          U {fmt2(under)}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// NBA Game Props card
// ---------------------------------------------------------------------------
function NbaGameCard({ game, activeMarket }) {
  const [expandedPlayer, setExpandedPlayer] = useState(null)
  const props = (game.props || []).filter(p =>
    activeMarket === 'all' ? true : p.market === activeMarket
  )

  // Group by player (all markets for that player)
  const byPlayer = {}
  props.forEach(p => {
    byPlayer[p.player] = byPlayer[p.player] || {}
    byPlayer[p.player][p.market] = p
  })

  const players = Object.keys(byPlayer).sort()
  if (!players.length) return null

  const timeStr = game.commence_time
    ? new Date(game.commence_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
      {/* Game header */}
      <div className="bg-navy-700/60 px-4 py-3 flex items-center justify-between">
        <div>
          <span className="text-sm font-bold text-gray-100">
            {game.home_team} <span className="text-gray-500 font-normal text-xs">vs</span> {game.away_team}
          </span>
          {timeStr && <span className="text-xs text-gray-600 ml-2">{timeStr}</span>}
        </div>
        <span className="text-xs text-gray-500">{props.length} props</span>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-4 py-2 border-b border-navy-700/50 text-xs text-gray-600 font-medium">
        <div>Player</div>
        <div className="text-center w-16">Line</div>
        <div className="text-center w-28">FanDuel</div>
        <div className="text-center w-28">DraftKings</div>
      </div>

      {/* Player rows */}
      <div className="divide-y divide-navy-700/40">
        {players.map(player => {
          const playerMarkets = byPlayer[player]
          const isExpanded = expandedPlayer === player
          // Pick the first/best market for compact view
          const firstMkt = activeMarket !== 'all'
            ? playerMarkets[activeMarket]
            : (playerMarkets['player_points'] || Object.values(playerMarkets)[0])

          if (!firstMkt) return null

          return (
            <div key={player}>
              {/* Compact row — click to expand */}
              <button
                className="w-full grid grid-cols-[1fr_auto_auto_auto] gap-2 px-4 py-2.5 hover:bg-navy-700/30 transition-colors text-left"
                onClick={() => setExpandedPlayer(p => p === player ? null : player)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-300 font-medium">{player}</span>
                  {activeMarket === 'all' && Object.keys(playerMarkets).length > 1 && (
                    <span className="text-xs text-gray-600">(+{Object.keys(playerMarkets).length - 1} mkts)</span>
                  )}
                </div>
                <div className="w-16 text-center">
                  <span className={`text-xs font-bold ${MARKET_COLORS[firstMkt.market] || 'text-gray-300'}`}>
                    {firstMkt.line}
                  </span>
                  <span className="text-xs text-gray-600 ml-1 truncate">{MARKET_LABELS[firstMkt.market]?.split(' ')[1] || firstMkt.market_label?.charAt(0)}</span>
                </div>
                <div className="w-28">
                  <OddsCell
                    label="FD"
                    over={firstMkt.fanduel_over}
                    under={firstMkt.fanduel_under}
                    line={firstMkt.fanduel_line}
                    highlight={false}
                  />
                </div>
                <div className="w-28">
                  <OddsCell
                    label="DK"
                    over={firstMkt.draftkings_over}
                    under={firstMkt.draftkings_under}
                    line={firstMkt.draftkings_line}
                    highlight={false}
                  />
                </div>
              </button>

              {/* Expanded view: all markets for this player */}
              {isExpanded && (
                <div className="px-4 pb-3 space-y-2 bg-navy-700/20">
                  {Object.entries(playerMarkets).map(([mkt, p]) => (
                    <div key={mkt} className={`rounded-lg border p-3 ${MARKET_BG[mkt] || 'bg-navy-700/40 border-navy-600'}`}>
                      <div className={`text-xs font-bold mb-2 ${MARKET_COLORS[mkt] || 'text-gray-300'}`}>
                        {p.market_label} — Line: {p.line}
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {/* Best odds */}
                        <div className="bg-navy-800/60 rounded p-2 text-center">
                          <div className="text-xs text-gray-500 mb-1">Best</div>
                          <div className="text-xs">
                            <span className="text-green-400 font-bold">O {fmt2(p.over_odds)}</span>
                            <span className="text-gray-700 mx-1">/</span>
                            <span className="text-red-400 font-bold">U {fmt2(p.under_odds)}</span>
                          </div>
                          <div className="text-xs text-gray-700 mt-0.5">{p.best_bk}</div>
                        </div>
                        {/* FanDuel */}
                        <div className="bg-navy-800/60 rounded p-2 text-center">
                          <div className="text-xs text-gray-500 mb-1">FanDuel</div>
                          {p.fanduel_over ? (
                            <div className="text-xs">
                              <span className="text-green-400 font-semibold">O {fmt2(p.fanduel_over)}</span>
                              <span className="text-gray-700 mx-1">/</span>
                              <span className="text-red-400 font-semibold">U {fmt2(p.fanduel_under)}</span>
                            </div>
                          ) : <div className="text-gray-700 text-xs">—</div>}
                        </div>
                        {/* DraftKings */}
                        <div className="bg-navy-800/60 rounded p-2 text-center">
                          <div className="text-xs text-gray-500 mb-1">DraftKings</div>
                          {p.draftkings_over ? (
                            <div className="text-xs">
                              <span className="text-green-400 font-semibold">O {fmt2(p.draftkings_over)}</span>
                              <span className="text-gray-700 mx-1">/</span>
                              <span className="text-red-400 font-semibold">U {fmt2(p.draftkings_under)}</span>
                            </div>
                          ) : <div className="text-gray-700 text-xs">—</div>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Soccer alt markets panel
// ---------------------------------------------------------------------------
function SoccerAltPanel({ sportKey, event }) {
  const [open, setOpen] = useState(false)
  const url = open
    ? `${API_BASE}/api/odds/soccer-alt/${sportKey}/${event.event_id}?home_team=${encodeURIComponent(event.home_team)}&away_team=${encodeURIComponent(event.away_team)}`
    : null
  const { data, loading, error } = useApi(url)

  const timeStr = event.commence_time
    ? new Date(event.commence_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
      {/* Event header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-navy-700/30 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div>
          <span className="text-sm font-bold text-gray-100">
            {event.home_team} <span className="text-gray-500 font-normal text-xs">vs</span> {event.away_team}
          </span>
          {timeStr && <span className="text-xs text-gray-600 ml-2">{timeStr}</span>}
        </div>
        <span className="text-xs text-gray-500">{open ? '▲ Hide' : '▼ Alt markets'}</span>
      </button>

      {open && (
        <div className="border-t border-navy-700 px-4 py-3 space-y-3">
          {loading && <p className="text-xs text-gray-500">Loading alt markets…</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
          {data && !loading && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* BTTS */}
              <div className="bg-navy-700/50 rounded-lg p-3 border border-navy-600">
                <div className="text-xs font-bold text-green-400 mb-2">BTTS</div>
                <div className="text-xs text-gray-500 mb-1">Both Teams to Score</div>
                {data.btts_yes_odds ? (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Yes</span>
                      <span className="text-green-400 font-bold">{fmt2(data.btts_yes_odds)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">No</span>
                      <span className="text-gray-300 font-semibold">{fmt2(data.btts_no_odds)}</span>
                    </div>
                    <div className="text-xs text-gray-700 mt-1">via {data.btts_bk}</div>
                  </div>
                ) : <p className="text-xs text-gray-700">No market data</p>}
              </div>

              {/* Draw No Bet */}
              <div className="bg-navy-700/50 rounded-lg p-3 border border-navy-600">
                <div className="text-xs font-bold text-blue-400 mb-2">Draw No Bet</div>
                <div className="text-xs text-gray-500 mb-1">Refunded if draw</div>
                {data.dnb_home_odds ? (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400 truncate mr-2">{event.home_team}</span>
                      <span className="text-blue-400 font-bold shrink-0">{fmt2(data.dnb_home_odds)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400 truncate mr-2">{event.away_team}</span>
                      <span className="text-blue-300 font-semibold shrink-0">{fmt2(data.dnb_away_odds)}</span>
                    </div>
                    <div className="text-xs text-gray-700 mt-1">via {data.dnb_bk}</div>
                  </div>
                ) : <p className="text-xs text-gray-700">No market data</p>}
              </div>

              {/* Goal Scorers */}
              <div className="bg-navy-700/50 rounded-lg p-3 border border-navy-600">
                <div className="text-xs font-bold text-yellow-400 mb-2">Anytime Scorer</div>
                <div className="text-xs text-gray-500 mb-1">To score anytime</div>
                {data.goal_scorers?.length ? (
                  <div className="space-y-1">
                    {data.goal_scorers.slice(0, 6).map((s, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="text-gray-300 truncate mr-2">{s.player}</span>
                        <span className="text-yellow-400 font-semibold shrink-0">{fmt2(s.odds)}</span>
                      </div>
                    ))}
                    {data.goal_scorers.length > 6 && (
                      <p className="text-xs text-gray-700">+{data.goal_scorers.length - 6} more</p>
                    )}
                  </div>
                ) : <p className="text-xs text-gray-700">No market data</p>}
              </div>
            </div>
          )}

          {/* Corners/Cards note */}
          <div className="bg-navy-700/40 border border-navy-600/50 rounded-lg px-3 py-2 text-xs text-gray-600">
            Corners and Cards markets are not available in The Odds API (not offered on any plan).
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Soccer events loader
// ---------------------------------------------------------------------------
function SoccerSection({ sportKey }) {
  const { data, loading, error } = useApi(`${API_BASE}/api/odds/soccer-events/${sportKey}`)
  const events = data?.events ?? []

  if (loading) return <Loader />
  if (error)   return <ErrorBox message={error} />
  if (!events.length) return (
    <p className="text-xs text-gray-600 py-4 text-center">No upcoming events found for this league.</p>
  )

  return (
    <div className="space-y-3">
      {events.map(ev => (
        <SoccerAltPanel key={ev.event_id} sportKey={sportKey} event={ev} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// NBA section — auto-refresh every 60s
// ---------------------------------------------------------------------------
function NbaSection() {
  const [tick, setTick] = useState(0)
  const [lastRefresh, setLastRefresh] = useState(Date.now())
  const [countdown, setCountdown] = useState(60)
  const [activeMarket, setActiveMarket] = useState('all')
  const [search, setSearch] = useState('')
  const intervalRef = useRef(null)

  // Auto-refresh every 60s
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setTick(t => t + 1)
      setLastRefresh(Date.now())
      setCountdown(60)
    }, 60000)
    return () => clearInterval(intervalRef.current)
  }, [])

  // Countdown timer
  useEffect(() => {
    const t = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(t)
  }, [lastRefresh])

  const { data, loading, error, refetch } = useApi(`${API_BASE}/api/props/nba`)

  const handleRefresh = () => {
    refetch()
    setLastRefresh(Date.now())
    setCountdown(60)
  }

  const games = (data?.games ?? []).filter(g => g.props?.length > 0)

  // Filter by player search
  const filteredGames = search.trim()
    ? games.map(g => ({
        ...g,
        props: g.props.filter(p =>
          p.player.toLowerCase().includes(search.toLowerCase())
        )
      })).filter(g => g.props.length > 0)
    : games

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Market filter */}
        <div className="flex flex-wrap gap-1">
          {[
            { key: 'all', label: 'All' },
            ...Object.entries(MARKET_LABELS).map(([key, label]) => ({ key, label }))
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveMarket(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                activeMarket === key
                  ? 'bg-brand-600 border-brand-500 text-white'
                  : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Player search */}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search player…"
          className="bg-navy-700 border border-navy-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 w-44"
        />

        {/* Refresh */}
        <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
          <span>Auto-refresh in {countdown}s</span>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="border border-navy-600 rounded-lg px-3 py-1.5 hover:text-gray-300 hover:border-navy-500 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Loading…' : 'Refresh now'}
          </button>
        </div>
      </div>

      {/* Total props badge */}
      {data && (
        <p className="text-xs text-gray-600">
          {data.total_props} player-market combos across {games.length} games
          {' · '}FanDuel + DraftKings
          {' · '}Cached 15 min
        </p>
      )}

      {loading && <Loader />}
      {error && <ErrorBox message={error} />}

      {!loading && filteredGames.length === 0 && !error && (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-8 text-center text-gray-500">
          <div className="text-3xl mb-3">🏀</div>
          <p className="text-sm">No NBA props available right now.</p>
          <p className="text-xs mt-1 text-gray-600">
            Props are typically posted 1–2 days before tip-off.
          </p>
        </div>
      )}

      {filteredGames.map(game => (
        <NbaGameCard key={game.event_id} game={game} activeMarket={activeMarket} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ML Prop Card (NBA Stats API game log predictions)
// ---------------------------------------------------------------------------

function MLPropCard({ pred }) {
  const [open, setOpen] = useState(false)
  const [legendLang, setLegendLang] = useState('en')
  const [factorLang, setFactorLang] = useState('en')
  const [showNeutralFactors, setShowNeutralFactors] = useState(false)
  const [aiFactorTips, setAiFactorTips] = useState(null)
  const [aiTipsLoading, setAiTipsLoading] = useState(false)
  const [activeFactor, setActiveFactor] = useState(null)
  const gameStr = pred.home_team && pred.away_team
    ? `${pred.home_team} vs ${pred.away_team}` : ''
  const timeStr = pred.commence_time
    ? new Date(pred.commence_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  const isOver  = pred.call === 'Over'
  const modelOverProb = isOver ? Number(pred.confidence || 0.5) : (1 - Number(pred.confidence || 0.5))
  const modelUnderProb = 1 - modelOverProb
  const hitRate = isOver ? pred.hit_rate_over : pred.hit_rate_under
  const hitPct  = hitRate != null ? Math.round(hitRate * 100) : null
  const shortTeam = pred.team_abbr || (pred.team || '').split(' ').map(s => s[0]).join('').slice(0, 3).toUpperCase()
  const statKey = pred.market === 'player_points' ? 'PTS'
    : pred.market === 'player_rebounds' ? 'REB'
    : pred.market === 'player_assists' ? 'AST'
    : pred.market === 'player_threes' ? '3PT'
    : 'PTS'

  const c = pred.context || {}
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const modelFactors = [
    {
      key: 'momentum',
      label_en: 'Momentum',
      label_es: 'Momentum',
      val: num(c.momentum_score),
      tip_en: `Shows if the player is trending up or down lately. If he's producing more than in his previous games, this helps the pick.`,
      tip_es: `Muestra si el jugador viene subiendo o bajando. Si esta produciendo mas que en sus juegos previos, esto ayuda al pick.`,
    },
    {
      key: 'usage',
      label_en: 'Usage',
      label_es: 'Uso',
      val: num(c.usage_trend),
      tip_en: `How involved he is on offense. More shots or touches usually means more chances to hit props.`,
      tip_es: `Que tan involucrado esta en ataque. Mas tiros o mas uso normalmente significa mas opciones de pegar el prop.`,
    },
    {
      key: 'matchup',
      label_en: 'Matchup',
      label_es: 'Emparejamiento',
      val: num(c.defense_vs_pos_score),
      tip_en: `How hard this opponent is against this player type (guard/forward/center). Easier defense helps overs. Tough defense hurts them.`,
      tip_es: `Que tan dificil es este rival para este tipo de jugador (guard/forward/center). Defensa facil ayuda a los overs. Defensa dura los baja.`,
    },
    {
      key: 'pace',
      label_en: 'Pace',
      label_es: 'Ritmo',
      val: num(c.pace_score),
      tip_en: `Game speed. Faster games create more possessions and more stat opportunities. Slower games do the opposite.`,
      tip_es: `Velocidad del juego. Juegos rapidos crean mas posesiones y mas oportunidades de estadisticas. Juegos lentos hacen lo contrario.`,
    },
    {
      key: 'minutes',
      label_en: 'Minutes',
      label_es: 'Minutos',
      val: num(c.minutes_trend),
      tip_en: `If he is playing more minutes recently, he has more time to produce. If minutes are dropping, risk goes up.`,
      tip_es: `Si esta jugando mas minutos recientemente, tiene mas tiempo para producir. Si los minutos bajan, sube el riesgo.`,
    },
    {
      key: 'rest',
      label_en: 'Rest',
      label_es: 'Descanso',
      val: -num(c.is_b2b) * 0.6 - num(c.games_last7 > 4 ? 0.3 : 0) + (num(c.days_rest, 2) >= 2 ? 0.25 : 0),
      tip_en: `Fresh players usually perform better. Back-to-back games or heavy weekly load can lower performance.`,
      tip_es: `Jugadores frescos normalmente rinden mejor. Back-to-back o mucha carga semanal puede bajar el rendimiento.`,
    },
    {
      key: 'starter',
      label_en: 'Starter',
      label_es: 'Titularidad',
      val: num(c.starter_probability) - 0.5,
      tip_en: `How likely he is to have a stable role. More stable role = more predictable stats.`,
      tip_es: `Que tan probable es que tenga un rol estable. Rol mas estable = estadisticas mas predecibles.`,
    },
    {
      key: 'market',
      label_en: 'Market',
      label_es: 'Mercado',
      val: num(c.market_alignment),
      tip_en: `If sportsbooks show similar lines, confidence is usually better. Big differences between books increase uncertainty.`,
      tip_es: `Si las casas muestran lineas parecidas, normalmente hay mas confianza. Diferencias grandes entre casas aumentan la incertidumbre.`,
    },
  ]

  const sortedFactors = [...modelFactors].sort((a, b) => Math.abs(b.val) - Math.abs(a.val))
  const visibleFactors = showNeutralFactors
    ? sortedFactors
    : sortedFactors.filter((f) => Math.abs(f.val) > 0.12)
  const hiddenNeutralCount = sortedFactors.length - visibleFactors.length

  const loadAiFactorTips = async (forceRegen = false) => {
    setAiTipsLoading(true)
    try {
      const r = await fetch(`${API_BASE}/api/props/nba/factor-explanations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player: pred.player,
          market_label: pred.market_label,
          call: pred.call,
          line: pred.line,
          confidence: pred.confidence,
          context: pred.context || {},
          force_regen: forceRegen,
        }),
      })
      const j = await r.json()
      if (j && (j.en || j.es)) setAiFactorTips(j)
    } catch {}
    setAiTipsLoading(false)
  }

  useEffect(() => {
    if (!open || aiFactorTips || aiTipsLoading) return
    let cancelled = false
    const run = async () => {
      await loadAiFactorTips(false)
      if (cancelled) return
    }
    run()
    return () => { cancelled = true }
  }, [open, aiFactorTips, aiTipsLoading, pred])

  const factorUi = (v) => {
    if (v > 0.12) return { arrow: '↑', cls: 'text-green-400', bg: 'bg-green-900/25 border-green-800/50' }
    if (v < -0.12) return { arrow: '↓', cls: 'text-red-400', bg: 'bg-red-900/20 border-red-800/50' }
    return { arrow: '→', cls: 'text-yellow-300', bg: 'bg-yellow-900/20 border-yellow-800/50' }
  }

  return (
    <div onClick={() => setOpen(v => !v)} className={`bg-navy-800 border rounded-xl p-4 space-y-3 hover:border-navy-500 transition-colors cursor-pointer ${
      pred.tier === 'Strong' ? 'border-green-800/60' :
      pred.tier === 'Moderate' ? 'border-yellow-800/50' : 'border-navy-700'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {pred.player_headshot ? (
            <img src={pred.player_headshot} alt={pred.player} className="w-10 h-10 rounded-full object-cover object-top border border-navy-600" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-navy-700 border border-navy-600 flex items-center justify-center text-xs font-bold text-gray-300">{(pred.player || '?').split(' ').map(s => s[0]).slice(0,2).join('')}</div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-bold text-gray-100 truncate">{pred.player}</p>
            <p className="text-xs text-blue-400/70 mt-0.5 truncate">{pred.market_label} · {shortTeam || pred.team || 'TEAM'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {pred.team_logo && <img src={pred.team_logo} alt={pred.team || 'team'} className="w-6 h-6 object-contain" />}
          {pred.opponent_logo && <img src={pred.opponent_logo} alt={pred.opponent || 'opp'} className="w-6 h-6 object-contain opacity-80" />}
          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${TIER_COLORS[pred.tier]}`}>
            {pred.tier}
          </span>
        </div>
      </div>

      {/* Main call */}
      <div className="flex items-center justify-between">
        <div>
          <span className={`text-2xl font-bold ${CALL_COLOR[pred.call]}`}>{pred.call}</span>
          <span className="text-lg font-bold text-gray-300 ml-2">{pred.line}</span>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Prop: Over {pred.line} / Under {pred.line}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Rolling avg</p>
          <p className={`text-base font-bold ${isOver ? 'text-green-400' : 'text-red-400'}`}>
            {pred.rolling_mean ?? '—'}
          </p>
        </div>
      </div>

      {/* Confidence bar */}
      <div>
        <p className="text-xs text-gray-500 mb-1">Max Confidence (context adjusted)</p>
        <ConfidenceBar value={pred.confidence} />
      </div>

      {/* Over / Under board */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className={`rounded-lg px-2.5 py-2 border ${pred.call === 'Over' ? 'bg-green-900/25 border-green-800/60' : 'bg-navy-700/45 border-navy-700'}`}>
          <p className="text-gray-500">Over {pred.line}</p>
          <p className={`font-bold ${pred.call === 'Over' ? 'text-green-400' : 'text-gray-300'}`}>
            AI {Math.round(modelOverProb * 100)}%
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">Market {pred.dv_over_prob != null ? `${Math.round(pred.dv_over_prob * 100)}%` : '—'}</p>
          <p className="text-gray-500">FD {pred.fanduel_over ? Number(pred.fanduel_over).toFixed(2) : '—'} · DK {pred.draftkings_over ? Number(pred.draftkings_over).toFixed(2) : '—'}</p>
          <p className={`mt-0.5 font-semibold ${pred.call === 'Over' ? 'text-emerald-300' : 'text-gray-500'}`}>
            {pred.call === 'Over' ? 'AI Recommended' : 'AI Fade'}
          </p>
        </div>
        <div className={`rounded-lg px-2.5 py-2 border ${pred.call === 'Under' ? 'bg-red-900/25 border-red-800/60' : 'bg-navy-700/45 border-navy-700'}`}>
          <p className="text-gray-500">Under {pred.line}</p>
          <p className={`font-bold ${pred.call === 'Under' ? 'text-red-400' : 'text-gray-300'}`}>
            AI {Math.round(modelUnderProb * 100)}%
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">Market {pred.dv_under_prob != null ? `${Math.round(pred.dv_under_prob * 100)}%` : '—'}</p>
          <p className="text-gray-500">FD {pred.fanduel_under ? Number(pred.fanduel_under).toFixed(2) : '—'} · DK {pred.draftkings_under ? Number(pred.draftkings_under).toFixed(2) : '—'}</p>
          <p className={`mt-0.5 font-semibold ${pred.call === 'Under' ? 'text-rose-300' : 'text-gray-500'}`}>
            {pred.call === 'Under' ? 'AI Recommended' : 'AI Fade'}
          </p>
        </div>
      </div>

      {pred.context && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-navy-700/50 rounded-lg px-2 py-2">
            <p className="text-gray-500 mb-0.5">Game importance</p>
            <p className="text-gray-200 font-semibold">{Math.round((pred.context.game_importance || 0.5) * 100)}%</p>
          </div>
          <div className="bg-navy-700/50 rounded-lg px-2 py-2">
            <p className="text-gray-500 mb-0.5">Underdog pressure</p>
            <p className={`font-semibold ${(pred.context.underdog_strength || 0) > 0 ? 'text-yellow-300' : 'text-gray-300'}`}>
              {((pred.context.underdog_strength || 0) > 0 ? '+' : '') + Math.round((pred.context.underdog_strength || 0) * 100)}
            </p>
          </div>
          <div className="bg-navy-700/50 rounded-lg px-2 py-2">
            <p className="text-gray-500 mb-0.5">Team injuries</p>
            <p className="text-orange-300 font-semibold">{Math.round((pred.context.team_injury_load || 0) * 100)}%</p>
          </div>
          <div className="bg-navy-700/50 rounded-lg px-2 py-2">
            <p className="text-gray-500 mb-0.5">Opponent injuries</p>
            <p className="text-cyan-300 font-semibold">{Math.round((pred.context.opp_injury_load || 0) * 100)}%</p>
          </div>
        </div>
      )}

      {pred.context && (
        <div className="bg-navy-700/35 border border-navy-700 rounded-lg p-2">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <p className="text-[10px] uppercase tracking-wide text-gray-500">{factorLang === 'es' ? 'Factores del Modelo' : 'Model Factors'}</p>
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); setShowNeutralFactors(v => !v) }}
                className="text-[10px] px-2 py-0.5 rounded border border-navy-600 text-gray-400 hover:text-gray-200"
              >
                {showNeutralFactors
                  ? (factorLang === 'es' ? 'Ocultar neutros' : 'Hide neutral')
                  : (factorLang === 'es' ? `Ver neutros (${hiddenNeutralCount})` : `Show neutral (${hiddenNeutralCount})`)}
              </button>
              {aiTipsLoading && (
                <span className="text-[10px] text-blue-300">AI…</span>
              )}
              {!aiTipsLoading && aiFactorTips?.source === 'gemini' && (
                <span className="text-[10px] text-emerald-300">AI ready</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); loadAiFactorTips(true) }}
                className="text-[10px] px-2 py-0.5 rounded border border-blue-800/60 text-blue-300 hover:text-blue-200"
              >
                {factorLang === 'es' ? 'Regenerar IA' : 'Regenerate AI'}
              </button>
              <div className="inline-flex bg-navy-700 rounded-lg p-0.5 border border-navy-600">
                <button
                  onClick={(e) => { e.stopPropagation(); setFactorLang('en') }}
                  className={`px-2 py-0.5 text-[10px] rounded ${factorLang === 'en' ? 'bg-brand-600 text-white' : 'text-gray-400'}`}>
                  EN
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setFactorLang('es') }}
                  className={`px-2 py-0.5 text-[10px] rounded ${factorLang === 'es' ? 'bg-brand-600 text-white' : 'text-gray-400'}`}>
                  ES
                </button>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
            {visibleFactors.map((f) => {
              const ui = factorUi(f.val)
              return (
                <div
                  key={f.key}
                  className={`group relative rounded-md border px-2 py-1 ${ui.bg}`}
                  onMouseEnter={() => setActiveFactor(f.key)}
                  onMouseLeave={() => setActiveFactor((v) => (v === f.key ? null : v))}
                  onClick={(e) => {
                    e.stopPropagation()
                    setActiveFactor((v) => (v === f.key ? null : f.key))
                  }}
                >
                  <p className="text-[10px] text-gray-400">{factorLang === 'es' ? f.label_es : f.label_en}</p>
                  <p className={`text-xs font-bold ${ui.cls}`}>{ui.arrow} {Math.round(f.val * 100)}</p>
                  <div className={`absolute z-20 left-0 top-full mt-1 w-56 rounded-lg border border-navy-600 bg-navy-900/95 px-2.5 py-2 shadow-xl ${activeFactor === f.key ? 'block' : 'hidden group-hover:block'}`}>
                    <p className="text-[11px] leading-relaxed text-gray-200">
                      {(() => {
                        const src = factorLang === 'es' ? aiFactorTips?.es : aiFactorTips?.en
                        return (src && src[f.key]) || (factorLang === 'es' ? f.tip_es : f.tip_en)
                      })()}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2 text-xs text-center">
        <div className="bg-navy-700/50 rounded-lg px-2 py-2">
          <p className="text-gray-500 mb-0.5">Avg ± Std</p>
          <p className="text-gray-200 font-medium">
            {pred.rolling_mean ?? '—'} ± {pred.rolling_std ?? '—'}
          </p>
        </div>
        <div className="bg-navy-700/50 rounded-lg px-2 py-2">
          <p className="text-gray-500 mb-0.5">Last 5 avg</p>
          <p className={`font-medium ${(pred.last5_mean ?? pred.last10_mean ?? pred.last3_mean ?? 0) > pred.line ? 'text-green-400' : 'text-red-400'}`}>
            {pred.last5_mean ?? pred.last10_mean ?? pred.last3_mean ?? '—'}
          </p>
        </div>
        <div className="bg-navy-700/50 rounded-lg px-2 py-2">
          <p className="text-gray-500 mb-0.5">Hit rate</p>
          <p className={`font-medium ${hitPct >= 60 ? 'text-green-400' : hitPct >= 50 ? 'text-yellow-400' : 'text-gray-400'}`}>
            {hitPct != null ? `${hitPct}%` : '—'}
          </p>
        </div>
      </div>

      {/* Game info */}
      <div className="flex items-center justify-between text-xs text-navy-500">
        <span>{gameStr}{timeStr ? ` · ${timeStr}` : ''}</span>
        <span className="text-navy-600">{pred.n_games} games</span>
      </div>

      {open && (
        <div className="pt-2 border-t border-navy-700/70 space-y-4" onClick={e => e.stopPropagation()}>
          {pred.season_overview && (
            <div className="bg-[#1f5f96] border border-[#2f7dbf] rounded-xl overflow-hidden">
              <div className="flex items-end justify-between px-3 pt-2">
                <div className="h-28 w-28 shrink-0">
                  {pred.player_headshot ? (
                    <img src={pred.player_headshot} alt={pred.player} className="h-full w-full object-contain object-bottom" />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-white/70 text-xs">No image</div>
                  )}
                </div>
                <div className="pb-3 pr-1 text-right">
                  <p className="text-white text-2xl font-black leading-tight">{pred.player}</p>
                  <p className="text-blue-100/90 text-xs font-semibold mt-1">{pred.season_overview.season || 'Regular Season'}</p>
                </div>
              </div>
              <div className="px-3 pb-3 grid grid-cols-3 gap-2 text-xs text-white/95">
                <div className="bg-white/10 rounded-lg px-2 py-1.5"><p className="font-bold">{pred.season_overview.position || '—'}</p><p className="text-[10px] text-blue-100/85">Position</p></div>
                <div className="bg-white/10 rounded-lg px-2 py-1.5"><p className="font-bold">#{pred.season_overview.number || '—'}</p><p className="text-[10px] text-blue-100/85">Number</p></div>
                <div className="bg-white/10 rounded-lg px-2 py-1.5"><p className="font-bold">{pred.season_overview.age || '—'}</p><p className="text-[10px] text-blue-100/85">Age</p></div>
              </div>
              <div className="mx-3 mb-3 bg-[#276ea9] border border-[#3f89c7] rounded-xl px-3 py-3">
                <p className="text-white font-bold text-sm mb-2">Season Averages</p>
                <div className="grid grid-cols-5 gap-2 text-center">
                  {[['PPG', pred.season_overview.ppg], ['RPG', pred.season_overview.rpg], ['APG', pred.season_overview.apg], ['SPG', pred.season_overview.spg], ['BPG', pred.season_overview.bpg]].map(([k, v]) => (
                    <div key={k}><p className="text-white font-extrabold text-base">{v || '—'}</p><p className="text-[10px] text-blue-100/90">{k}</p></div>
                  ))}
                </div>
                <div className="grid grid-cols-5 gap-2 text-center mt-2.5">
                  {[['MPG', pred.season_overview.mpg], ['FG%', pred.season_overview.fg_pct], ['3P%', pred.season_overview.tp_pct], ['FT%', pred.season_overview.ft_pct], ['TS%', pred.season_overview.ts_pct]].map(([k, v]) => (
                    <div key={k}><p className="text-white font-extrabold text-base">{v || '—'}</p><p className="text-[10px] text-blue-100/90">{k}</p></div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2 gap-2">
              <p className="text-xs font-semibold text-gray-300">Why this confidence is {Math.round((pred.confidence || 0.5) * 100)}%</p>
              <div className="inline-flex bg-navy-700 rounded-lg p-0.5 border border-navy-600">
                <button
                  onClick={() => setLegendLang('en')}
                  className={`px-2 py-0.5 text-[10px] rounded ${legendLang === 'en' ? 'bg-brand-600 text-white' : 'text-gray-400'}`}>
                  EN
                </button>
                <button
                  onClick={() => setLegendLang('es')}
                  className={`px-2 py-0.5 text-[10px] rounded ${legendLang === 'es' ? 'bg-brand-600 text-white' : 'text-gray-400'}`}>
                  ES
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {(legendLang === 'es' ? (pred.confidence_legend_es || pred.confidence_legend || []) : (pred.confidence_legend || [])).map((line, idx) => {
                const parts = String(line || '').split(':')
                const title = parts[0] || ''
                const detail = parts.slice(1).join(':').trim()
                return (
                  <div key={idx} className="bg-navy-700/35 border border-navy-700 rounded-lg px-2.5 py-2">
                    <p className="text-xs leading-relaxed text-gray-200">
                      <span className="font-bold text-gray-100">{title}:</span>{' '}
                      <span>{detail || line}</span>
                    </p>
                  </div>
                )
              })}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-400 mb-1">Last 10 games ({statKey})</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-navy-700">
                    <th className="text-left py-1">Date</th>
                    <th className="text-left py-1">Opp</th>
                    <th className="text-right py-1">MIN</th>
                    <th className="text-right py-1">PTS</th>
                    <th className="text-right py-1">REB</th>
                    <th className="text-right py-1">AST</th>
                    <th className="text-right py-1">3PT</th>
                  </tr>
                </thead>
                <tbody>
                  {(pred.recent_games || []).map((g, idx) => (
                    <tr key={`${g.date || 'd'}-${idx}`} className="border-b border-navy-800/70">
                      <td className="py-1 text-gray-300">{g.date || '—'}</td>
                      <td className="py-1 text-gray-400">{g.opponent || '—'}</td>
                      <td className="py-1 text-right text-gray-300">{g.MIN ?? '—'}</td>
                      <td className="py-1 text-right text-gray-300">{g.PTS ?? '—'}</td>
                      <td className="py-1 text-right text-gray-300">{g.REB ?? '—'}</td>
                      <td className="py-1 text-right text-gray-300">{g.AST ?? '—'}</td>
                      <td className="py-1 text-right text-gray-300">{g['3PT'] ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI Prop Predictions
// ---------------------------------------------------------------------------

const TIER_COLORS = {
  Strong:   'bg-green-900/50 text-green-300 border border-green-700',
  Moderate: 'bg-yellow-900/40 text-yellow-300 border border-yellow-700',
  Lean:     'bg-navy-700 text-gray-400 border border-navy-600',
}

const CALL_COLOR = { Over: 'text-green-400', Under: 'text-red-400' }

function ConfidenceBar({ value }) {
  // value is 0.5–1.0; display as 50–100%
  const pct = Math.round(value * 100)
  const fill = Math.round((value - 0.5) * 200) // 0–100 width
  const color = fill >= 20 ? 'bg-green-500' : fill >= 10 ? 'bg-yellow-500' : 'bg-blue-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-navy-900 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${fill}%` }} />
      </div>
      <span className="text-xs font-bold text-gray-200 w-10 text-right">{pct}%</span>
    </div>
  )
}

function PropPredCard({ pred }) {
  const gameStr = pred.home_team && pred.away_team
    ? `${pred.home_team} vs ${pred.away_team}`
    : ''
  const timeStr = pred.commence_time
    ? new Date(pred.commence_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 space-y-3 hover:border-navy-500 transition-colors">
      {/* Player + market */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-gray-100">{pred.player}</p>
          <p className="text-xs text-blue-400/70 mt-0.5">{pred.market_label}</p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ${TIER_COLORS[pred.tier]}`}>
          {pred.tier}
        </span>
      </div>

      {/* Call */}
      <div className="flex items-center justify-between">
        <div>
          <span className={`text-2xl font-bold ${CALL_COLOR[pred.call]}`}>
            {pred.call}
          </span>
          <span className="text-lg font-bold text-gray-300 ml-2">{pred.line}</span>
          <span className="text-xs text-gray-500 ml-1">{pred.market_label?.split(' ')[0]}</span>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Best odds</p>
          <p className="text-sm font-bold text-gray-200">{pred.call_odds?.toFixed(2) ?? '—'}</p>
        </div>
      </div>

      {/* Confidence bar */}
      <div>
        <p className="text-xs text-gray-500 mb-1">Confidence</p>
        <ConfidenceBar value={pred.confidence} />
      </div>

      {/* Over/Under breakdown */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className={`rounded-lg px-3 py-2 text-center ${pred.call === 'Over' ? 'bg-green-900/30 border border-green-800/60' : 'bg-navy-700/50'}`}>
          <p className="text-gray-500 mb-0.5">Over implied</p>
          <p className={`font-bold ${pred.call === 'Over' ? 'text-green-400' : 'text-gray-400'}`}>
            {Math.round(pred.over_prob * 100)}%
          </p>
          <p className="text-gray-600 mt-0.5">{pred.fanduel_over ? `FD ${pred.fanduel_over.toFixed(2)}` : pred.over_odds?.toFixed(2) ?? '—'}</p>
        </div>
        <div className={`rounded-lg px-3 py-2 text-center ${pred.call === 'Under' ? 'bg-red-900/30 border border-red-800/60' : 'bg-navy-700/50'}`}>
          <p className="text-gray-500 mb-0.5">Under implied</p>
          <p className={`font-bold ${pred.call === 'Under' ? 'text-red-400' : 'text-gray-400'}`}>
            {Math.round(pred.under_prob * 100)}%
          </p>
          <p className="text-gray-600 mt-0.5">{pred.fanduel_under ? `FD ${pred.fanduel_under.toFixed(2)}` : pred.under_odds?.toFixed(2) ?? '—'}</p>
        </div>
      </div>

      {/* Game info */}
      {gameStr && (
        <p className="text-xs text-navy-500">
          {gameStr}{timeStr ? ` · ${timeStr}` : ''}
        </p>
      )}
    </div>
  )
}

// NBA team name → abbreviation
const NBA_ABBR = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
  'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
  'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
  'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL',
  'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL',
  'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NOP',
  'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL',
  'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX', 'Portland Trail Blazers': 'POR',
  'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR',
  'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
}
function abbr(name) { return NBA_ABBR[name] || (name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 3) }

function AIPredictionsSection() {
  const [marketFilter, setMarketFilter] = useState('all')
  const [tierFilter,   setTierFilter]   = useState('all')
  const [search,       setSearch]       = useState('')
  const [gameFilter,   setGameFilter]   = useState('all')  // 'all' or 'HOME_TEAM|AWAY_TEAM'
  const [lineMode,     setLineMode]     = useState('open')
  const [parlayMsg,    setParlayMsg]    = useState('')
  const [parlays,      setParlays]      = useState([])
  const [parlayLang,   setParlayLang]   = useState('es')
  const [lineupMode,   setLineupMode]   = useState('probable')
  const [pickSource,   setPickSource]   = useState('ml')
  const [bankStart,    setBankStart]    = useState(100)
  const [bankroll,     setBankroll]     = useState(100)
  const [bankRiskPct,  setBankRiskPct]  = useState(0.03)
  const [bankLog,      setBankLog]      = useState([])
  const { addBet } = useBetSlip()

  // ML predictions (NBA Stats API game logs) — Points, Rebounds, Assists
  const mlUrl = `${API_BASE}/api/props/nba/ml-predictions?market=${marketFilter}&tier=${tierFilter}&line_mode=${lineMode}`
  const mlAllUrl = `${API_BASE}/api/props/nba/ml-predictions?market=all&tier=all&line_mode=${lineMode}`
  const { data: mlData, loading: mlLoading, error: mlError, refetch: mlRefetch } = useApi(mlUrl)
  const { data: mlAllData } = useApi((marketFilter === 'all' && tierFilter === 'all') ? null : mlAllUrl)
  const shouldUseSimpleFallback = Boolean(mlError) || Boolean(mlData && (mlData.total || 0) === 0)
  const simpleUrl = shouldUseSimpleFallback
    ? `${API_BASE}/api/props/nba/predictions?market=${marketFilter}&tier=${tierFilter}`
    : null
  const simpleAllUrl = shouldUseSimpleFallback && !(marketFilter === 'all' && tierFilter === 'all')
    ? `${API_BASE}/api/props/nba/predictions?market=all&tier=all`
    : null
  const { data: simpleData, loading: simpleLoading, error: simpleError, refetch: simpleRefetch } = useApi(simpleUrl)
  const { data: simpleAllData } = useApi(simpleAllUrl)
  const { data: rawData, loading: rawLoading, error: rawError, refetch: rawRefetch } = useApi(`${API_BASE}/api/props/nba`)
  const { data: histData, loading: histLoading, error: histError, refetch: histRefetch } = useApi(`${API_BASE}/api/props/nba/ml-history?limit=80`)
  const { data: parlayHistData, loading: parlayHistLoading, error: parlayHistError, refetch: parlayHistRefetch } = useApi(`${API_BASE}/api/props/nba/parlays/history?limit=40`)

  // Derive unique games from predictions
  const mlPreds = mlData?.predictions ?? []
  const simplePreds = simpleData?.predictions ?? []
  const usingSimpleFallback = shouldUseSimpleFallback && simplePreds.length > 0
  const allPreds = usingSimpleFallback ? simplePreds : mlPreds
  const parlayPreds = usingSimpleFallback
    ? ((marketFilter === 'all' && tierFilter === 'all') ? allPreds : (simpleAllData?.predictions ?? allPreds))
    : ((marketFilter === 'all' && tierFilter === 'all') ? allPreds : (mlAllData?.predictions ?? allPreds))

  const lineupReady = (p) => {
    if (lineupMode === 'off') return true
    const hasLineupContext = p?.context && (p.context.starter_probability != null || p.context.minutes_stability != null)
    if (!hasLineupContext) return lineupMode === 'probable'
    const starter = Number(p?.context?.starter_probability || 0)
    const stable = Number(p?.context?.minutes_stability || 0)
    const tipTs = p?.commence_time ? Date.parse(p.commence_time) : NaN
    const minsToTip = Number.isFinite(tipTs) ? ((tipTs - Date.now()) / 60000) : 9999
    if (lineupMode === 'confirmed') {
      return starter >= 0.72 && stable >= 0.55 && minsToTip <= 90
    }
    return starter >= 0.60 && stable >= 0.42
  }

  const eligibleParlayPreds = parlayPreds.filter(lineupReady)
  const games = []
  const seenGames = new Set()
  for (const p of allPreds) {
    if (p.home_team && p.away_team) {
      const key = `${p.home_team}|${p.away_team}`
      if (!seenGames.has(key)) {
        seenGames.add(key)
        games.push({ key, home: p.home_team, away: p.away_team, commence_time: p.commence_time })
      }
    }
  }

  const preds = allPreds.filter(p => {
    if (gameFilter !== 'all') {
      const key = `${p.home_team}|${p.away_team}`
      if (key !== gameFilter) return false
    }
    if (search.trim()) {
      if (!p.player?.toLowerCase().includes(search.toLowerCase())) return false
    }
    return true
  })

  const gameOuLeans = useMemo(() => {
    const grouped = new Map()
    for (const p of preds) {
      const key = `${p.home_team || 'TBD'}|${p.away_team || 'TBD'}`
      const overProb = p.call === 'Over' ? Number(p.confidence || 0.5) : (1 - Number(p.confidence || 0.5))
      const underProb = 1 - overProb
      const tierW = p.tier === 'Strong' ? 1.25 : p.tier === 'Moderate' ? 1.0 : 0.8
      const w = tierW * Math.max(0.6, Number(p.context?.quality_score || 1))
      const cur = grouped.get(key) || {
        home_team: p.home_team,
        away_team: p.away_team,
        commence_time: p.commence_time,
        overScore: 0,
        underScore: 0,
        picks: 0,
      }
      cur.overScore += overProb * w
      cur.underScore += underProb * w
      cur.picks += 1
      grouped.set(key, cur)
    }

    return [...grouped.values()]
      .filter(g => g.picks >= 3)
      .map(g => {
        const total = g.overScore + g.underScore
        const overShare = total > 0 ? g.overScore / total : 0.5
        const lean = overShare >= 0.5 ? 'Over' : 'Under'
        const confidence = 0.5 + Math.abs(overShare - 0.5)
        return {
          ...g,
          lean,
          overShare,
          confidence,
        }
      })
      .sort((a, b) => b.confidence - a.confidence)
  }, [preds])

  const rawProps = useMemo(() => {
    const gamesRaw = rawData?.games || []
    const rows = []
    for (const g of gamesRaw) {
      for (const p of (g.props || [])) {
        rows.push({ ...p, home_team: g.home_team, away_team: g.away_team, commence_time: g.commence_time })
      }
    }
    return rows.filter((p) => {
      if (gameFilter !== 'all') {
        const key = `${p.home_team}|${p.away_team}`
        if (key !== gameFilter) return false
      }
      if (search.trim() && !String(p.player || '').toLowerCase().includes(search.toLowerCase())) return false
      if (marketFilter !== 'all' && p.market !== marketFilter) return false
      return true
    })
  }, [rawData, gameFilter, search, marketFilter])

  const mlUiLoading = mlLoading || (shouldUseSimpleFallback && simpleLoading && !usingSimpleFallback)
  const mlUiError = (!usingSimpleFallback && mlError)
    || (shouldUseSimpleFallback && !usingSimpleFallback && simpleError)

  const MARKET_FILTER_OPTIONS = [
    { key: 'all',             label: 'All' },
    { key: 'player_points',   label: 'Points' },
    { key: 'player_rebounds', label: 'Rebounds' },
    { key: 'player_assists',  label: 'Assists' },
    { key: 'player_threes',   label: '3PM' },
  ]

  const getPickOdds = (p) => Number(
    p.call === 'Over'
      ? (p.fanduel_over ?? p.over_odds)
      : (p.fanduel_under ?? p.under_odds)
  ) || 2.0

  const bankScore = (p) => {
    const conf = Number(p.confidence || 0)
    const quality = Number(p.context?.quality_score || 1)
    const edge = Number(p.model_market_edge ?? p.context?.model_market_edge ?? 0)
    const unc = Number(p.context?.uncertainty_score || 0)
    return conf + 0.22 * (quality - 0.8) + 0.45 * edge - 0.25 * unc
  }

  const bankPicks = useMemo(() => {
    const pool = [...eligibleParlayPreds]
      .filter(p => (p.fanduel_over || p.fanduel_under || p.over_odds || p.under_odds))
      .filter(p => Number(p.confidence || 0) >= 0.56)
      .sort((a, b) => bankScore(b) - bankScore(a))

    const out = []
    const usedGames = new Set()
    const usedPlayers = new Set()

    for (const p of pool) {
      const gk = `${p.home_team}|${p.away_team}`
      const pk = `${p.player}|${p.market}`
      if (usedGames.has(gk) || usedPlayers.has(pk)) continue
      out.push(p)
      usedGames.add(gk)
      usedPlayers.add(pk)
      if (out.length >= 10) break
    }

    if (out.length < 10) {
      for (const p of pool) {
        const pk = `${p.player}|${p.market}`
        if (usedPlayers.has(pk)) continue
        out.push(p)
        usedPlayers.add(pk)
        if (out.length >= 10) break
      }
    }

    return out
  }, [eligibleParlayPreds, lineupMode])

  const recommendedStake = (p) => {
    const edge = Number(p.model_market_edge ?? p.context?.model_market_edge ?? 0)
    const unc = Number(p.context?.uncertainty_score || 0)
    const risk = Math.max(0.005, Math.min(0.12, Number(bankRiskPct || 0.03)))
    const mult = Math.max(0.7, Math.min(1.7, 1 + 2.8 * edge - 0.8 * unc))
    const raw = bankroll * risk * mult
    return Math.max(2, Math.min(bankroll * 0.12, raw))
  }

  const applyBankResult = (p, result) => {
    if (bankroll <= 0) return
    const odds = getPickOdds(p)
    const stake = Number(recommendedStake(p).toFixed(2))
    let delta = 0
    if (result === 'win') delta = stake * Math.max(0, odds - 1)
    else if (result === 'lose') delta = -stake
    const next = Math.max(0, Number((bankroll + delta).toFixed(2)))
    setBankroll(next)
    setBankLog(prev => [
      {
        at: new Date().toISOString(),
        player: p.player,
        market: p.market_label,
        call: p.call,
        line: p.line,
        result,
        stake,
        odds,
        delta: Number(delta.toFixed(2)),
        balance_after: next,
      },
      ...prev,
    ].slice(0, 80))
  }

  const resetBankroll = () => {
    const base = Math.max(1, Number(bankStart || 100))
    setBankroll(base)
    setBankLog([])
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem('ai_props_bank_v1')
      if (!raw) return
      const data = JSON.parse(raw)
      if (typeof data?.bankStart === 'number') setBankStart(data.bankStart)
      if (typeof data?.bankroll === 'number') setBankroll(data.bankroll)
      if (typeof data?.bankRiskPct === 'number') setBankRiskPct(data.bankRiskPct)
      if (Array.isArray(data?.bankLog)) setBankLog(data.bankLog.slice(0, 80))
    } catch {}
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('ai_props_bank_v1', JSON.stringify({ bankStart, bankroll, bankRiskPct, bankLog }))
    } catch {}
  }, [bankStart, bankroll, bankRiskPct, bankLog])

  const bankPnl = Number((bankroll - bankStart).toFixed(2))
  const bankRoi = bankStart > 0 ? (bankPnl / bankStart) : 0

  const makePropSlipBet = (p) => {
    const odds = p.call === 'Over'
      ? (p.fanduel_over ?? p.over_odds)
      : (p.fanduel_under ?? p.under_odds)
    return {
      home_team: p.home_team || 'NBA',
      away_team: p.away_team || 'Props',
      bet_side: `${p.player}|${p.market}|${p.call}`,
      bet_team: p.player,
      bet_type: 'player_prop',
      bet_type_label: `${p.market_label} ${p.call} ${p.line}`,
      league: 'NBA',
      sport: 'nba',
      odds: Number(odds) || 2.0,
      model_prob: p.confidence || null,
      edge: p.edge || null,
      notes: `AI Props ${p.tier} · ${p.call} ${p.line}`,
    }
  }

  const pickDiverseLegs = (arr, targetCount, scoreFn) => {
    const sorted = [...arr].sort((a, b) => scoreFn(b) - scoreFn(a))
    const chosen = []
    const usedPlayers = new Set()

    while (chosen.length < targetCount) {
      let best = null
      let bestAdj = -Infinity
      for (const cand of sorted) {
        if (usedPlayers.has(cand.player)) continue
        let penalty = 0
        for (const sel of chosen) {
          if (cand.team && sel.team && cand.team === sel.team) penalty += 0.06
          if (cand.market && sel.market && cand.market === sel.market) penalty += 0.08
          if (cand.call && sel.call && cand.call === sel.call) penalty += 0.03
        }
        const adj = scoreFn(cand) - penalty
        if (adj > bestAdj) {
          bestAdj = adj
          best = cand
        }
      }
      if (!best) break
      chosen.push(best)
      usedPlayers.add(best.player)
    }
    return chosen
  }

  const buildSolidParlayToSlip = () => {
    const legKey = (p) => {
      const lineNum = Number(p?.line)
      const lineTxt = Number.isFinite(lineNum) ? lineNum.toFixed(2) : String(p?.line ?? '')
      return [
        p?.event_id || `${p?.home_team}|${p?.away_team}`,
        p?.player,
        p?.market,
        p?.call,
        lineTxt,
      ].join('|')
    }

    const score = (p) => {
      const conf = Number(p.confidence || 0)
      const qualityBoost = 0.24 * ((Number(p.context?.quality_score || 1) - 0.8))
      const marketEdgeBoost = 0.42 * Number(p.model_market_edge ?? p.context?.model_market_edge ?? 0)
      const evBoost = 0.16 * Number(p.ev_per_unit || 0)
      const uncertaintyPenalty = 0.22 * Number(p.context?.uncertainty_score || 0)
      return conf + qualityBoost + marketEdgeBoost + evBoost - uncertaintyPenalty
    }

    const strong = [...eligibleParlayPreds]
      .filter(p => p.tier === 'Strong' && (p.fanduel_over || p.fanduel_under || p.over_odds || p.under_odds))
      .sort((a, b) => score(b) - score(a))

    const pool = strong.length >= 8
      ? strong
      : [...eligibleParlayPreds]
          .filter(p => (p.tier === 'Strong' || p.tier === 'Moderate') && (p.fanduel_over || p.fanduel_under || p.over_odds || p.under_odds))
          .sort((a, b) => score(b) - score(a))

    // Need exactly 8 legs: 2 selections per game across 4 games
    const byGame = new Map()
    for (const p of pool) {
      const gk = `${p.home_team}|${p.away_team}`
      if (!byGame.has(gk)) byGame.set(gk, [])
      byGame.get(gk).push(p)
    }

    const gameCandidates = []
    for (const [gk, arr] of byGame.entries()) {
      const pick2 = pickDiverseLegs(arr, 2, score)
      if (pick2.length >= 2) {
        gameCandidates.push({ gk, legs: pick2, gameScore: score(pick2[0]) + score(pick2[1]) })
      }
    }

    gameCandidates.sort((a, b) => b.gameScore - a.gameScore)
    if (gameCandidates.length < 4) {
      setParlayMsg('Not enough solid games with 2 good selections each. Need 4 games × 2 legs.')
      return
    }

    const combos = []
    const maxGames = Math.min(8, gameCandidates.length)
    const arr = gameCandidates.slice(0, maxGames)
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        for (let c = b + 1; c < arr.length; c++) {
          for (let d = c + 1; d < arr.length; d++) {
            const gs = [arr[a], arr[b], arr[c], arr[d]]
            combos.push({
              id: `${arr[a].gk}__${arr[b].gk}__${arr[c].gk}__${arr[d].gk}`,
              games: gs,
              legs: gs.flatMap(x => x.legs),
              score: gs.reduce((s, x) => s + x.gameScore, 0),
              explanation: null,
              loading: true,
            })
          }
        }
      }
    }

    combos.sort((x, y) => y.score - x.score)
    const selected = []
    const usedGlobalLegs = new Set()
    for (const combo of combos) {
      const keys = combo.legs.map(legKey)
      if (keys.some(k => usedGlobalLegs.has(k))) continue
      selected.push(combo)
      keys.forEach(k => usedGlobalLegs.add(k))
      if (selected.length >= 3) break
    }

    if (!selected.length) {
      setParlayMsg('No safe parlays without repeated picks were found.')
      setParlays([])
      return
    }

    setParlays(selected)
    setParlayMsg(`Built ${selected.length} safe parlays with no repeated picks across parlays.`)

    const enrich = async (parlay) => {
      try {
        const body = {
          legs: parlay.legs.map(l => ({
            player: l.player,
            market_label: l.market_label,
            call: l.call,
            line: l.line,
            confidence: l.confidence,
            tier: l.tier,
            home_team: l.home_team,
            away_team: l.away_team,
          }))
        }
        const r = await fetch(`${API_BASE}/api/props/nba/parlay-explain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = await r.json()
        setParlays(prev => prev.map(p => p.id === parlay.id ? { ...p, explanation: j, loading: false } : p))
      } catch {
        setParlays(prev => prev.map(p => p.id === parlay.id ? { ...p, loading: false } : p))
      }
    }
    selected.forEach(enrich)
    selected.forEach((p) => logParlayHistory(p, 'safe'))

    setTimeout(() => setParlayMsg(''), 2600)
  }

  const sendParlayToSlip = (parlay) => {
    parlay.legs.forEach(p => addBet(makePropSlipBet(p)))
    setParlayMsg(`Added ${parlay.legs.length} legs from selected parlay to slip.`)
    setTimeout(() => setParlayMsg(''), 2600)
  }

  const logParlayHistory = async (parlay, kind = 'safe') => {
    try {
      await fetch(`${API_BASE}/api/props/nba/parlays/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          score: parlay.score,
          legs: parlay.legs.map(l => ({
            player: l.player,
            market: l.market,
            line: l.line,
            call: l.call,
            confidence: l.confidence,
            tier: l.tier,
            home_team: l.home_team,
            away_team: l.away_team,
          })),
        }),
      })
      parlayHistRefetch()
    } catch {}
  }

  const buildDreamParlay = () => {
    const legsPerGame = 4
    const targetGames = 6
    const minGames = 3
    const score = (p) => {
      const conf = Number(p.confidence || 0)
      const marketEdge = Number(p.model_market_edge ?? p.context?.model_market_edge ?? 0)
      const ev = Number(p.ev_per_unit || 0)
      const quality = Number(p.context?.quality_score || 1)
      const uncertainty = Number(p.context?.uncertainty_score || 0)
      return conf * 0.48 + marketEdge * 0.36 + ev * 0.10 + quality * 0.08 - uncertainty * 0.22
    }

    const strongPool = [...eligibleParlayPreds]
      .filter(p => (p.tier === 'Strong' || p.tier === 'Moderate') && (p.fanduel_over || p.fanduel_under || p.over_odds || p.under_odds))
      .sort((a, b) => score(b) - score(a))

    const fallbackPool = [...eligibleParlayPreds]
      .filter(p => (p.fanduel_over || p.fanduel_under || p.over_odds || p.under_odds))
      .sort((a, b) => score(b) - score(a))

    const pool = strongPool.length >= 18 ? strongPool : fallbackPool

    const byGame = new Map()
    for (const p of pool) {
      const gk = `${p.home_team}|${p.away_team}`
      if (!byGame.has(gk)) byGame.set(gk, [])
      byGame.get(gk).push(p)
    }

    const gameCandidates = []
    for (const [gk, arr] of byGame.entries()) {
      const picks = pickDiverseLegs(arr, legsPerGame, score)
      if (picks.length >= legsPerGame) {
        gameCandidates.push({
          gk,
          legs: picks.slice(0, legsPerGame),
          gameScore: picks.reduce((s, x) => s + score(x), 0),
        })
      }
    }

    gameCandidates.sort((a, b) => b.gameScore - a.gameScore)
    const selectedGames = gameCandidates.slice(0, Math.min(targetGames, gameCandidates.length))

    if (selectedGames.length < minGames) {
      setParlayMsg(`No hay suficientes juegos con ${legsPerGame} picks fuertes por juego. Prueba All + All Tiers o cambia a Live Lines.`)
      return
    }
    const dream = {
      id: `dream_${Date.now()}`,
      games: selectedGames,
      legs: selectedGames.flatMap(x => x.legs),
      score: selectedGames.reduce((s, x) => s + x.gameScore, 0),
      explanation: null,
      loading: true,
      kind: 'dream',
    }

    setParlays(prev => [dream, ...prev.slice(0, 2)])
    setParlayMsg(`Built dream parlay: ${selectedGames.length} games × ${legsPerGame} legs = ${dream.legs.length} legs.`)
    logParlayHistory(dream, 'dream')

    ;(async () => {
      try {
        const body = {
          legs: dream.legs.map(l => ({
            player: l.player,
            market_label: l.market_label,
            call: l.call,
            line: l.line,
            confidence: l.confidence,
            tier: l.tier,
            home_team: l.home_team,
            away_team: l.away_team,
          }))
        }
        const r = await fetch(`${API_BASE}/api/props/nba/parlay-explain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = await r.json()
        setParlays(prev => prev.map(p => p.id === dream.id ? { ...p, explanation: j, loading: false } : p))
      } catch {
        setParlays(prev => prev.map(p => p.id === dream.id ? { ...p, loading: false } : p))
      }
    })()

    setTimeout(() => setParlayMsg(''), 2600)
  }

  return (
    <div className="space-y-4">

      {/* ML source badge */}
      <div className="flex items-center gap-2 text-xs text-blue-400/70">
        <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse-slow inline-block" />
        Predictions powered by ESPN box scores (last 5 games + momentum) · {lineMode === 'open' ? 'Open-lines mode (low API usage)' : 'Live-lines mode'}
      </div>

      {/* Game filter chips */}
      {games.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {/* All games chip */}
          <button
            onClick={() => setGameFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
              gameFilter === 'all'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-navy-800 border-navy-600 text-gray-400 hover:border-navy-500 hover:text-gray-200'
            }`}
          >
            All Games
          </button>

          {games.map(g => {
            const key = g.key
            const isActive = gameFilter === key
            const timeStr = g.commence_time
              ? new Date(g.commence_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : ''
            return (
              <button
                key={key}
                onClick={() => setGameFilter(isActive ? 'all' : key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                  isActive
                    ? 'bg-brand-600 border-brand-500 text-white shadow-lg shadow-brand-900/30'
                    : 'bg-navy-800 border-navy-600 text-gray-300 hover:border-navy-500 hover:text-white'
                }`}
              >
                <span className={isActive ? 'text-white' : 'text-gray-400'}>{abbr(g.away)}</span>
                <span className="text-navy-500 font-normal">@</span>
                <span className={isActive ? 'text-white' : 'text-gray-200'}>{abbr(g.home)}</span>
                {timeStr && (
                  <span className={`font-normal ml-0.5 ${isActive ? 'text-blue-200' : 'text-navy-500'}`}>
                    {timeStr}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Summary strip */}
      {mlData && (
        <div className="flex gap-3 flex-wrap text-xs">
          <div className="bg-navy-800 border border-navy-700 rounded-lg px-3 py-2">
            <span className="text-gray-500">Total </span>
            <span className="text-gray-200 font-bold">{mlData.total}</span>
          </div>
          <div className="bg-navy-800 border border-green-800/50 rounded-lg px-3 py-2">
            <span className="text-gray-500">Strong </span>
            <span className="text-green-400 font-bold">{mlData.strong}</span>
          </div>
          <div className="bg-navy-800 border border-yellow-800/50 rounded-lg px-3 py-2">
            <span className="text-gray-500">Moderate </span>
            <span className="text-yellow-400 font-bold">{mlData.moderate}</span>
          </div>
          <div className="bg-navy-800 border border-navy-600 rounded-lg px-3 py-2">
            <span className="text-gray-500">Lean </span>
            <span className="text-gray-400 font-bold">{mlData.lean}</span>
          </div>
        </div>
      )}

      {pickSource === 'ml' && gameOuLeans.length > 0 && (
        <div className="bg-navy-800/60 border border-navy-700 rounded-xl p-3 space-y-2">
          <p className="text-xs font-bold text-gray-300">AI Picks · Per-Game Over/Under Lean</p>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {gameOuLeans.map((g, idx) => (
              <div key={`${g.home_team}-${g.away_team}-${idx}`} className="bg-navy-700/35 border border-navy-700 rounded-lg px-2.5 py-2 text-xs">
                <p className="text-gray-200 font-semibold truncate">{abbr(g.away_team)} @ {abbr(g.home_team)}</p>
                <p className="text-gray-500 truncate">{g.commence_time ? new Date(g.commence_time).toLocaleString() : 'Game time TBD'}</p>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className={`font-bold ${g.lean === 'Over' ? 'text-green-400' : 'text-red-400'}`}>{g.lean}</span>
                  <span className="text-gray-300">AI {Math.round(g.confidence * 100)}%</span>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">Based on {g.picks} AI player props</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-navy-800/60 border border-emerald-800/40 rounded-xl p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold text-emerald-300">Bank Builder (Singles)</p>
            <p className="text-[11px] text-gray-500">Plan de banca para crecer tu balance con picks mas seguros (sin parlays).</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-500">Start</span>
            <input
              type="number"
              min="1"
              value={bankStart}
              onChange={(e) => setBankStart(Number(e.target.value || 100))}
              className="w-20 bg-navy-700 border border-navy-600 rounded px-2 py-1 text-gray-100"
            />
            <span className="text-gray-500">Risk %</span>
            <input
              type="number"
              step="0.1"
              min="0.5"
              max="12"
              value={(bankRiskPct * 100).toFixed(1)}
              onChange={(e) => setBankRiskPct(Math.max(0.005, Math.min(0.12, Number(e.target.value || 3) / 100)))}
              className="w-16 bg-navy-700 border border-navy-600 rounded px-2 py-1 text-gray-100"
            />
            <button
              onClick={resetBankroll}
              className="px-2.5 py-1 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-900/20"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <div className="bg-navy-700/40 rounded-lg px-2 py-1.5"><span className="text-gray-500">Bankroll</span> <span className="text-gray-100 font-bold">${bankroll.toFixed(2)}</span></div>
          <div className="bg-navy-700/40 rounded-lg px-2 py-1.5"><span className="text-gray-500">Start</span> <span className="text-gray-200 font-bold">${Number(bankStart || 0).toFixed(2)}</span></div>
          <div className={`rounded-lg px-2 py-1.5 border ${bankPnl >= 0 ? 'bg-green-900/20 border-green-800/50' : 'bg-red-900/20 border-red-800/50'}`}><span className="text-gray-500">PnL</span> <span className={`font-bold ${bankPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{bankPnl >= 0 ? '+' : ''}${bankPnl.toFixed(2)}</span></div>
          <div className={`rounded-lg px-2 py-1.5 border ${bankRoi >= 0 ? 'bg-blue-900/20 border-blue-800/50' : 'bg-amber-900/20 border-amber-800/50'}`}><span className="text-gray-500">ROI</span> <span className={`font-bold ${bankRoi >= 0 ? 'text-blue-300' : 'text-amber-300'}`}>{(bankRoi * 100).toFixed(1)}%</span></div>
          <div className="bg-navy-700/40 rounded-lg px-2 py-1.5"><span className="text-gray-500">Actions</span> <span className="text-gray-200 font-bold">{bankLog.length}</span></div>
        </div>

        <div className="space-y-1.5 max-h-56 overflow-auto pr-1">
          {bankPicks.slice(0, 8).map((p, i) => {
            const stake = recommendedStake(p)
            const odds = getPickOdds(p)
            return (
              <div key={`${p.player}-${p.market}-${i}`} className="text-xs bg-navy-700/35 border border-navy-700 rounded-lg px-2.5 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-gray-100 truncate"><span className="font-bold">{p.player}</span> · {p.market_label} · {p.call} {p.line}</p>
                  <p className="text-gray-500 truncate">{abbr(p.away_team)} @ {abbr(p.home_team)} · conf {Math.round((p.confidence || 0) * 100)}% · edge {(Number(p.model_market_edge || 0) * 100).toFixed(1)}%</p>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  <span className="text-emerald-300 font-bold">${stake.toFixed(2)}</span>
                  <span className="text-gray-500">@{odds.toFixed(2)}</span>
                  <button onClick={() => addBet(makePropSlipBet(p))} className="px-2 py-0.5 rounded border border-blue-700 text-blue-300 hover:bg-blue-900/20">Slip</button>
                  <button onClick={() => applyBankResult(p, 'win')} className="px-2 py-0.5 rounded border border-green-700 text-green-300 hover:bg-green-900/20">W</button>
                  <button onClick={() => applyBankResult(p, 'lose')} className="px-2 py-0.5 rounded border border-red-700 text-red-300 hover:bg-red-900/20">L</button>
                  <button onClick={() => applyBankResult(p, 'push')} className="px-2 py-0.5 rounded border border-navy-600 text-gray-300 hover:bg-navy-700/40">P</button>
                </div>
              </div>
            )
          })}
          {bankPicks.length === 0 && (
            <p className="text-xs text-gray-500">No hay picks suficientes para banca en este momento.</p>
          )}
        </div>
      </div>

      <div className="bg-navy-800/60 border border-navy-700 rounded-xl p-3 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-gray-300">AI Props Results History</p>
          <button
            onClick={histRefetch}
            disabled={histLoading}
            className="text-xs text-gray-400 hover:text-gray-200 border border-navy-600 rounded-lg px-2.5 py-1 disabled:opacity-50"
          >
            {histLoading ? 'Updating…' : 'Refresh history'}
          </button>
        </div>

        {histError && <p className="text-xs text-red-400">{histError}</p>}

        {histData?.summary && (
          <div className="grid grid-cols-2 md:grid-cols-8 gap-2 text-xs">
            <div className="bg-navy-700/40 rounded-lg px-2 py-1.5"><span className="text-gray-500">Total</span> <span className="text-gray-200 font-bold">{histData.summary.total}</span></div>
            <div className="bg-green-900/20 border border-green-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Won</span> <span className="text-green-400 font-bold">{histData.summary.won}</span></div>
            <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Lost</span> <span className="text-red-400 font-bold">{histData.summary.lost}</span></div>
            <div className="bg-navy-700/40 rounded-lg px-2 py-1.5"><span className="text-gray-500">Push</span> <span className="text-gray-300 font-bold">{histData.summary.push}</span></div>
            <div className="bg-navy-700/40 rounded-lg px-2 py-1.5"><span className="text-gray-500">Pending</span> <span className="text-yellow-400 font-bold">{histData.summary.pending}</span></div>
            <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Hit rate</span> <span className="text-blue-300 font-bold">{histData.summary.hit_rate != null ? `${Math.round(histData.summary.hit_rate * 100)}%` : '—'}</span></div>
            <div className="bg-fuchsia-900/20 border border-fuchsia-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Avg CLV</span> <span className="text-fuchsia-300 font-bold">{histData.summary.avg_clv != null ? histData.summary.avg_clv.toFixed(3) : '—'}</span></div>
            <div className="bg-cyan-900/20 border border-cyan-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">+CLV rate</span> <span className="text-cyan-300 font-bold">{histData.summary.positive_clv_rate != null ? `${Math.round(histData.summary.positive_clv_rate * 100)}%` : '—'}</span></div>
          </div>
        )}

        {!!histData?.failed?.length && (
          <div>
            <p className="text-xs font-semibold text-red-300 mb-2">Recent failed props</p>
            <div className="space-y-1.5 max-h-52 overflow-auto pr-1">
              {histData.failed.slice(0, 20).map((r) => (
                <div key={r.id} className="text-xs bg-navy-700/35 border border-navy-700 rounded-lg px-2.5 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-gray-200 truncate"><span className="font-bold">{r.player}</span> · {String(r.market || '').replace('player_', '').replace('_', ' ').toUpperCase()} · {r.call} {r.line}</p>
                    <p className="text-gray-500 truncate">{r.team || '—'} vs {r.opponent || '—'} · pick {r.pick_date} · game {r.game_date || '—'}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-red-400 font-bold">L</p>
                    <p className="text-gray-400">actual {r.actual_value ?? '—'}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          <button
            onClick={() => setPickSource('ml')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              pickSource === 'ml' ? 'bg-brand-600 border-brand-500 text-white' : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
            }`}
          >
            AI ML Picks
          </button>
          <button
            onClick={() => setPickSource('raw')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              pickSource === 'raw' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
            }`}
          >
            Raw O/U Props
          </button>
        </div>

        <div className="flex items-center gap-1">
          {[
            { key: 'off', label: 'No Lineup Gate' },
            { key: 'probable', label: 'Probable Lineup' },
            { key: 'confirmed', label: 'Confirmed Lineup' },
          ].map(opt => (
            <button
              key={opt.key}
              onClick={() => setLineupMode(opt.key)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                lineupMode === opt.key
                  ? 'bg-amber-600 border-amber-500 text-white'
                  : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
          <span className="text-[11px] text-gray-500 ml-1">
            Eligible picks: {eligibleParlayPreds.length}/{parlayPreds.length}
          </span>
        </div>

        <div className="flex gap-1">
          <button
            onClick={() => setLineMode('open')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              lineMode === 'open'
                ? 'bg-emerald-600 border-emerald-500 text-white'
                : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
            }`}
          >
            Open Lines
          </button>
          <button
            onClick={() => setLineMode('live')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              lineMode === 'live'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
            }`}
          >
            Live Lines
          </button>
        </div>

        <button
          onClick={buildSolidParlayToSlip}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold border bg-emerald-600/20 border-emerald-700 text-emerald-300 hover:bg-emerald-600/30 transition-colors"
        >
          Build 3 Safe Parlays (8 legs)
        </button>

        <button
          onClick={buildDreamParlay}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold border bg-fuchsia-600/20 border-fuchsia-700 text-fuchsia-300 hover:bg-fuchsia-600/30 transition-colors"
        >
          Build Dream Parlay
        </button>

        {parlayMsg && (
          <span className="text-xs text-emerald-300">{parlayMsg}</span>
        )}

        {/* Market filter */}
        <div className="flex flex-wrap gap-1">
          {MARKET_FILTER_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setMarketFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                marketFilter === key
                  ? 'bg-brand-600 border-brand-500 text-white'
                  : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tier filter */}
        <div className="flex gap-1">
          {['all', 'Strong', 'Moderate', 'Lean'].map(t => (
            <button
              key={t}
              onClick={() => setTierFilter(t)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                tierFilter === t
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
              }`}
            >
              {t === 'all' ? 'All Tiers' : t}
            </button>
          ))}
        </div>

        {/* Player search */}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search player…"
          className="bg-navy-700 border border-navy-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 w-44"
        />

        <button
          onClick={() => {
            if (pickSource === 'ml') {
              mlRefetch()
              if (shouldUseSimpleFallback) simpleRefetch()
            } else {
              rawRefetch()
            }
          }}
          disabled={pickSource === 'ml' ? mlUiLoading : rawLoading}
          className="ml-auto text-xs text-gray-400 hover:text-gray-200 border border-navy-600 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          {(pickSource === 'ml' ? mlUiLoading : rawLoading) ? 'Loading…' : 'Refresh'}
        </button>

        {lineMode === 'open' && (
          <button
            onClick={async () => {
              try {
                await fetch(`${API_BASE}/api/props/nba/open-lines/refresh`, { method: 'POST' })
                mlRefetch()
              } catch {}
            }}
            className="text-xs text-emerald-300 hover:text-emerald-200 border border-emerald-800/60 rounded-lg px-3 py-1.5 transition-colors"
          >
            Refresh Open Snapshot
          </button>
        )}
      </div>

      {parlays.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-gray-200">AI Safe Parlay Builder</p>
            <div className="inline-flex bg-navy-700 rounded-lg p-0.5 border border-navy-600">
              <button onClick={() => setParlayLang('en')} className={`px-2 py-0.5 text-[10px] rounded ${parlayLang === 'en' ? 'bg-brand-600 text-white' : 'text-gray-400'}`}>EN</button>
              <button onClick={() => setParlayLang('es')} className={`px-2 py-0.5 text-[10px] rounded ${parlayLang === 'es' ? 'bg-brand-600 text-white' : 'text-gray-400'}`}>ES</button>
            </div>
          </div>

          {parlays.map((parlay, idx) => {
            const gameMap = new Map()
            ;(parlay.legs || []).forEach((leg) => {
              const key = `${leg.home_team || '?'}|${leg.away_team || '?'}`
              if (!gameMap.has(key)) {
                gameMap.set(key, { home: leg.home_team || 'TBD', away: leg.away_team || 'TBD' })
              }
            })
            const gameList = [...gameMap.values()]
            const gamesCount = gameList.length || (parlay.games?.length || 0)
            const legsCount = parlay.legs?.length || 0
            const picksPerGame = gamesCount > 0 ? (legsCount / gamesCount) : null

            return (
            <div key={parlay.id} className="bg-navy-800 border border-navy-700 rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500">Parlay #{idx + 1} {parlay.kind === 'dream' ? '· Dream' : '· Safe'}</p>
                  <p className={`text-sm font-bold ${parlay.kind === 'dream' ? 'text-fuchsia-300' : 'text-emerald-300'}`}>
                    {legsCount} legs · {gamesCount} games{picksPerGame ? ` · ${Number.isInteger(picksPerGame) ? picksPerGame : picksPerGame.toFixed(1)} picks/game` : ''} · score {parlay.score.toFixed(2)}
                  </p>
                </div>
                <button
                  onClick={() => sendParlayToSlip(parlay)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-emerald-700 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"
                >
                  Send to Slip
                </button>
              </div>

              {gameList.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {gameList.slice(0, 12).map((g, gi) => (
                    <span key={`${g.home}-${g.away}-${gi}`} className="text-[11px] px-2 py-0.5 rounded border border-navy-600 bg-navy-700/50 text-blue-200">
                      {abbr(g.away)} @ {abbr(g.home)}
                    </span>
                  ))}
                  {gameList.length > 12 && (
                    <span className="text-[11px] px-2 py-0.5 rounded border border-navy-700 bg-navy-700/30 text-gray-400">
                      +{gameList.length - 12} more games
                    </span>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                {parlay.legs.map((leg, i) => (
                  <div key={`${leg.player}-${leg.market}-${i}`} className="bg-navy-700/40 border border-navy-700 rounded-lg p-2">
                    <div className="flex items-center gap-2">
                      {leg.player_headshot ? (
                        <img src={leg.player_headshot} alt={leg.player} className="w-8 h-8 rounded-full object-cover object-top border border-navy-600" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-navy-800 border border-navy-600" />
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-gray-100 truncate">{leg.player}</p>
                        <p className="text-[11px] text-blue-300/80 truncate">{leg.market_label} · {leg.call} {leg.line}</p>
                        <p className="text-[10px] text-gray-500 truncate">{abbr(leg.away_team)} @ {abbr(leg.home_team)}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-2 text-[11px]">
                      <span className={`px-1.5 py-0.5 rounded border ${TIER_COLORS[leg.tier] || TIER_COLORS.Lean}`}>{leg.tier}</span>
                      <span className="text-emerald-300 font-bold">{Math.round((leg.confidence || 0) * 100)}%</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-navy-700/35 border border-navy-700 rounded-lg p-2.5">
                {parlay.loading ? (
                  <p className="text-xs text-blue-300">AI generating explanation…</p>
                ) : (
                  <>
                    <p className="text-xs font-semibold text-gray-200">
                      {parlayLang === 'es'
                        ? (parlay.explanation?.es?.summary || 'Parlay construido con las selecciones mas solidas disponibles.')
                        : (parlay.explanation?.en?.summary || 'Parlay built from the strongest available selections.')}
                    </p>
                    <div className="mt-2 space-y-1">
                      {(parlayLang === 'es' ? (parlay.explanation?.es?.bullets || []) : (parlay.explanation?.en?.bullets || [])).map((b, bi) => (
                        <p key={bi} className="text-xs text-gray-300">• {b}</p>
                      ))}
                    </div>
                    <div className="mt-2 space-y-1">
                      {(parlayLang === 'es' ? (parlay.explanation?.es?.risks || []) : (parlay.explanation?.en?.risks || [])).map((b, bi) => (
                        <p key={bi} className="text-xs text-yellow-300/90">⚠ {b}</p>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )})}
        </div>
      )}

      <div className="bg-navy-800/60 border border-navy-700 rounded-xl p-3 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-gray-300">Parlay History</p>
          <button
            onClick={parlayHistRefetch}
            disabled={parlayHistLoading}
            className="text-xs text-gray-400 hover:text-gray-200 border border-navy-600 rounded-lg px-2.5 py-1 disabled:opacity-50"
          >
            {parlayHistLoading ? 'Updating…' : 'Refresh'}
          </button>
        </div>

        {parlayHistError && <p className="text-xs text-red-400">{parlayHistError}</p>}

        {parlayHistData?.summary && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            <div className="bg-navy-700/40 rounded-lg px-2 py-1.5"><span className="text-gray-500">Total</span> <span className="text-gray-200 font-bold">{parlayHistData.summary.total}</span></div>
            <div className="bg-green-900/20 border border-green-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Won</span> <span className="text-green-400 font-bold">{parlayHistData.summary.won}</span></div>
            <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Lost</span> <span className="text-red-400 font-bold">{parlayHistData.summary.lost}</span></div>
            <div className="bg-navy-700/40 rounded-lg px-2 py-1.5"><span className="text-gray-500">Pending</span> <span className="text-yellow-400 font-bold">{parlayHistData.summary.pending}</span></div>
            <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg px-2 py-1.5"><span className="text-gray-500">Win rate</span> <span className="text-blue-300 font-bold">{parlayHistData.summary.hit_rate != null ? `${Math.round(parlayHistData.summary.hit_rate * 100)}%` : '—'}</span></div>
          </div>
        )}

        {!!parlayHistData?.parlays?.length && (
          <div className="space-y-1.5 max-h-56 overflow-auto pr-1">
            {parlayHistData.parlays.slice(0, 20).map((p) => (
              <div key={p.id} className="text-xs bg-navy-700/35 border border-navy-700 rounded-lg px-2.5 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-gray-200 truncate">
                    <span className="font-bold">#{p.id}</span> · {p.kind} · {p.legs_total} legs · {p.pick_date}
                  </p>
                  <p className="text-gray-500 truncate">Won {p.legs_won} · Lost {p.legs_lost} · Pending {p.legs_pending}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-bold ${p.result === 'won' ? 'text-green-400' : p.result === 'lost' ? 'text-red-400' : 'text-yellow-400'}`}>{String(p.result || 'pending').toUpperCase()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {(pickSource === 'ml' ? mlUiLoading : rawLoading) && <Loader />}
      {(pickSource === 'ml' ? mlUiError : rawError) && <ErrorBox message={pickSource === 'ml' ? mlUiError : rawError} />}

      {pickSource === 'ml' && usingSimpleFallback && (
        <div className="bg-amber-900/20 border border-amber-800/60 rounded-xl px-3 py-2 text-xs text-amber-200">
          ML endpoint timed out; showing fast fallback AI props for now.
        </div>
      )}

      {! (pickSource === 'ml' ? mlUiLoading : rawLoading) && !(pickSource === 'ml' ? mlUiError : rawError) && (pickSource === 'ml' ? preds.length === 0 : rawProps.length === 0) && (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-10 text-center">
          <p className="text-4xl mb-3">🏀</p>
          <p className="text-gray-400 text-sm">No props available right now.</p>
          <p className="text-gray-600 text-xs mt-1">Props are posted 1–2 days before tip-off. Check back closer to game time.</p>
        </div>
      )}

      {pickSource === 'ml' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {preds.map((pred, i) => (
            <MLPropCard key={`${pred.player}-${pred.market}-${i}`} pred={pred} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {rawProps.map((p, i) => (
            <div key={`${p.player}-${p.market}-${i}`} className="bg-navy-800 border border-navy-700 rounded-xl p-3">
              <p className="text-sm font-bold text-gray-100 truncate">{p.player}</p>
              <p className="text-xs text-blue-300/80 truncate">{p.market_label || p.market} · line {p.line}</p>
              <p className="text-[11px] text-gray-500 truncate mt-0.5">{abbr(p.away_team)} @ {abbr(p.home_team)}</p>
              <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                <div className="rounded-lg px-2 py-1.5 bg-green-900/20 border border-green-800/50">
                  <p className="text-gray-500">Over</p>
                  <p className="text-green-300 font-bold">FD {p.fanduel_over ? Number(p.fanduel_over).toFixed(2) : '—'}</p>
                  <p className="text-gray-500">DK {p.draftkings_over ? Number(p.draftkings_over).toFixed(2) : '—'}</p>
                </div>
                <div className="rounded-lg px-2 py-1.5 bg-red-900/20 border border-red-800/50">
                  <p className="text-gray-500">Under</p>
                  <p className="text-red-300 font-bold">FD {p.fanduel_under ? Number(p.fanduel_under).toFixed(2) : '—'}</p>
                  <p className="text-gray-500">DK {p.draftkings_under ? Number(p.draftkings_under).toFixed(2) : '—'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-gray-700 text-center pb-2">
        Predictions from NBA Stats API game logs · Rolling mean + hit rate + recency signals · Cached 30 min
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live Player Tracker
// ---------------------------------------------------------------------------

const STAT_COLORS = {
  hit:        { bar: 'bg-green-500',  text: 'text-green-400',  label: 'Hit' },
  close:      { bar: 'bg-yellow-400', text: 'text-yellow-400', label: 'Close' },
  needs_more: { bar: 'bg-blue-500',   text: 'text-gray-400',   label: '' },
  missed:     { bar: 'bg-red-500',    text: 'text-red-400',    label: 'Missed' },
  no_line:    { bar: 'bg-navy-600',   text: 'text-navy-500',   label: '' },
  scheduled:  { bar: 'bg-navy-600',   text: 'text-gray-400',   label: '' },
}

const STAT_LABELS = {
  PTS: 'PTS', REB: 'REB', AST: 'AST',
  '3PT': '3PM', STL: 'STL', BLK: 'BLK',
}

function BetOdds({ prop, myBet }) {
  const odds = myBet === 'over'
    ? (prop.fanduel_over ?? prop.over_odds)
    : (prop.fanduel_under ?? prop.under_odds)
  if (odds == null) return null
  return (
    <span className={`text-xs ml-1 ${myBet === 'over' ? 'text-green-400' : 'text-red-400'}`}>
      @{Number(odds).toFixed(2)}
    </span>
  )
}

function PropProgressRow({ prop, myBet, onSetBet, customLine, onSetLine }) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState('')

  // Use custom line if user has overridden it, otherwise use API line
  const activeLine = customLine ?? prop.line ?? null
  const hasLine    = activeLine != null && activeLine > 0
  const isCustom   = customLine != null && customLine !== prop.line

  const pct = Math.min(
    hasLine && prop.current != null && activeLine > 0
      ? (prop.current / activeLine) * 100
      : 0,
    100
  )

  // Colors based on bet position
  let colors = STAT_COLORS[prop.status] || STAT_COLORS.needs_more
  let betResult = null
  if (myBet && hasLine && prop.status !== 'no_line' && prop.status !== 'scheduled') {
    const hitting = prop.current > activeLine
    const winning = (myBet === 'over' && hitting) || (myBet === 'under' && !hitting)
    if (prop.status === 'hit' || prop.status === 'missed') {
      betResult = winning ? 'WON' : 'LOST'
      colors = winning ? STAT_COLORS.hit : STAT_COLORS.missed
    } else {
      betResult = winning ? 'WIN' : 'LOSE'
      colors = winning ? STAT_COLORS.hit : STAT_COLORS.needs_more
    }
  }

  const startEdit = () => {
    setEditVal(activeLine != null ? String(activeLine) : '')
    setEditing(true)
  }

  const commitEdit = () => {
    const val = parseFloat(editVal)
    if (!isNaN(val) && val > 0) onSetLine(prop.stat, val)
    else if (editVal === '') onSetLine(prop.stat, null) // reset to API line
    setEditing(false)
  }

  return (
    <div className="space-y-1 py-1 border-b border-navy-700/30 last:border-0">
      <div className="flex items-center gap-2">
        {/* Stat label */}
        <span className="text-xs font-bold text-gray-500 w-8 shrink-0">
          {STAT_LABELS[prop.stat] || prop.stat}
        </span>

        {/* Current stat value */}
        <span className={`text-sm font-bold tabular-nums shrink-0 w-6 ${colors.text}`}>
          {prop.current ?? 0}
        </span>

        {/* Line display / edit */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-navy-600 text-xs">/</span>
          {editing ? (
            <input
              autoFocus
              type="number"
              step="0.5"
              value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false) }}
              className="w-14 bg-navy-700 border border-yellow-600 rounded px-1.5 py-0.5 text-xs text-yellow-200 text-center outline-none tabular-nums"
            />
          ) : (
            <button
              onClick={startEdit}
              title="Click to edit line"
              className={`text-xs tabular-nums font-semibold px-1.5 py-0.5 rounded border transition-all ${
                hasLine
                  ? isCustom
                    ? 'text-yellow-300 border-yellow-700/60 bg-yellow-900/20 hover:border-yellow-500'
                    : 'text-navy-400 border-navy-700 hover:text-yellow-300 hover:border-yellow-700/60'
                  : 'text-navy-600 border-navy-800 hover:text-yellow-400 hover:border-yellow-700/40'
              }`}>
              {hasLine ? activeLine : '+ line'}
              {isCustom && <span className="text-yellow-600 ml-0.5 text-xs">✎</span>}
            </button>
          )}
          {isCustom && !editing && (
            <button onClick={() => onSetLine(prop.stat, null)}
              className="text-navy-600 hover:text-red-400 text-xs transition-colors" title="Reset to original line">
              ↺
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div className="flex-1 h-2 bg-navy-900 rounded-full overflow-hidden relative">
          {hasLine && (
            <div className={`h-full rounded-full transition-all duration-500 ${colors.bar}`}
              style={{ width: `${pct}%` }} />
          )}
          {hasLine && <div className="absolute right-0 top-0 h-full w-0.5 bg-navy-500/60" />}
        </div>

        {/* Result / status badge */}
        {betResult ? (
          <span className={`text-xs font-bold w-10 text-right shrink-0 ${
            betResult === 'WON' || betResult === 'WIN' ? 'text-green-400' : 'text-red-400'
          }`}>{betResult}</span>
        ) : colors.label ? (
          <span className={`text-xs font-bold w-10 text-right shrink-0 ${colors.text}`}>
            {colors.label}
          </span>
        ) : <span className="w-10" />}
      </div>

      {/* Bet position buttons */}
      {hasLine && onSetBet && (
        <div className="flex items-center gap-1.5 ml-10">
          <button
            onClick={() => onSetBet(prop.stat, myBet === 'over' ? null : 'over')}
            className={`px-2 py-0.5 rounded text-xs font-bold border transition-all ${
              myBet === 'over'
                ? 'bg-green-700 border-green-600 text-white'
                : 'bg-navy-700 border-navy-600 text-gray-500 hover:text-green-400 hover:border-green-700'
            }`}>
            Over {activeLine}
          </button>
          <button
            onClick={() => onSetBet(prop.stat, myBet === 'under' ? null : 'under')}
            className={`px-2 py-0.5 rounded text-xs font-bold border transition-all ${
              myBet === 'under'
                ? 'bg-red-700 border-red-600 text-white'
                : 'bg-navy-700 border-navy-600 text-gray-500 hover:text-red-400 hover:border-red-700'
            }`}>
            Under {activeLine}
          </button>
          {myBet && <BetOdds prop={prop} myBet={myBet} />}
        </div>
      )}
    </div>
  )
}

function PlayerTrackerCard({ player, isLive, isPinned, onTogglePin }) {
  const hasAnyLine = player.props.some(p => p.line != null)
  const playerSlug = (player.player || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
  const teamSlug = (player.team_abbr || player.team || '').toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'team_unknown'
  const storageKey      = `bets_${playerSlug}_${teamSlug}`
  const linesStorageKey = `lines_${playerSlug}_${teamSlug}`
  const legacyStorageKey = `bets_${player.player}`
  const legacyLinesStorageKey = `lines_${player.player}`

  const readFirstJson = (keys, fallback = {}) => {
    for (const k of keys) {
      try {
        const raw = localStorage.getItem(k)
        if (!raw) continue
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') return parsed
      } catch {}
    }
    return fallback
  }

  // Per-player bet positions: { PTS: 'over', REB: 'under', ... }
  const [bets, setBets] = useState(() => {
    return readFirstJson([storageKey, legacyStorageKey], {})
  })

  // Custom line overrides: { PTS: 22.5, REB: 6.0, ... } — null = reset to API line
  const [customLines, setCustomLines] = useState(() => {
    return readFirstJson([linesStorageKey, legacyLinesStorageKey], {})
  })

  // One-time migration from legacy player-only keys to scoped keys
  useEffect(() => {
    try {
      const scopedBets = localStorage.getItem(storageKey)
      const legacyBets = localStorage.getItem(legacyStorageKey)
      if (!scopedBets && legacyBets) localStorage.setItem(storageKey, legacyBets)

      const scopedLines = localStorage.getItem(linesStorageKey)
      const legacyLines = localStorage.getItem(legacyLinesStorageKey)
      if (!scopedLines && legacyLines) localStorage.setItem(linesStorageKey, legacyLines)
    } catch {}
  }, [storageKey, linesStorageKey, legacyStorageKey, legacyLinesStorageKey])

  const setBet = (stat, side) => {
    const next = { ...bets }
    if (side === null) delete next[stat]
    else next[stat] = side
    setBets(next)
    localStorage.setItem(storageKey, JSON.stringify(next))
    localStorage.setItem(legacyStorageKey, JSON.stringify(next))
  }

  const setLine = (stat, val) => {
    const next = { ...customLines }
    if (val === null) delete next[stat]
    else next[stat] = val
    setCustomLines(next)
    localStorage.setItem(linesStorageKey, JSON.stringify(next))
    localStorage.setItem(legacyLinesStorageKey, JSON.stringify(next))
  }

  const activeBets = Object.keys(bets).length

  // Overall parlay status using custom lines where set
  let parlayStatus = null
  if (activeBets > 0) {
    const results = player.props
      .filter(p => bets[p.stat])
      .map(p => {
        const line = customLines[p.stat] ?? p.line
        if (line == null) return null
        return (bets[p.stat] === 'over' && p.current > line) ||
               (bets[p.stat] === 'under' && p.current < line)
      })
      .filter(r => r !== null)
    if (results.length > 0) {
      if (results.every(Boolean)) parlayStatus = 'winning'
      else if (results.every(r => !r)) parlayStatus = 'losing'
      else parlayStatus = 'mixed'
    }
  }

  const parlayBorderColor = parlayStatus === 'winning' ? 'border-green-600 shadow-[0_0_12px_rgba(74,222,128,0.12)]'
    : parlayStatus === 'losing'  ? 'border-red-700'
    : parlayStatus === 'mixed'   ? 'border-yellow-700/60'
    : isPinned ? 'border-yellow-700/60 shadow-[0_0_8px_rgba(234,179,8,0.06)]'
    : isLive   ? 'border-green-800/50'
    : 'border-navy-700'

  return (
    <div className={`bg-navy-800 border rounded-xl p-4 space-y-2 transition-all ${parlayBorderColor}`}>
      {/* Player header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-gray-100">{player.player}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-xs text-navy-500">{player.team_abbr}</p>
            {(player.minutes ?? 0) > 0 && (
              <span className="text-xs text-blue-400/60 font-medium">{player.minutes} MIN</span>
            )}
            {player.avg_minutes != null && player.avg_minutes > 0 && (
              <span className="text-xs text-cyan-400/70 font-medium">AVG {player.avg_minutes} MIN</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Parlay status badge */}
          {parlayStatus && (
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
              parlayStatus === 'winning' ? 'bg-green-900/40 border-green-700 text-green-400' :
              parlayStatus === 'losing'  ? 'bg-red-900/40 border-red-700 text-red-400' :
              'bg-yellow-900/30 border-yellow-700 text-yellow-400'
            }`}>
              {parlayStatus === 'winning' ? '✓ Winning' :
               parlayStatus === 'losing'  ? '✗ Losing' : '~ Mixed'}
            </span>
          )}
          {activeBets > 0 && !parlayStatus && (
            <span className="text-xs text-navy-500">{activeBets} bet{activeBets > 1 ? 's' : ''}</span>
          )}
          {!hasAnyLine && <span className="text-xs text-navy-600">No lines</span>}
          <button onClick={() => onTogglePin(player.player)}
            title={isPinned ? 'Remove from My Players' : 'Add to My Players'}
            className={`text-sm transition-colors ${isPinned ? 'text-yellow-400 hover:text-red-400' : 'text-navy-600 hover:text-yellow-400'}`}>
            {isPinned ? '⭐' : '☆'}
          </button>
        </div>
      </div>

      {/* Stat rows — key by stat name so React never reuses wrong component */}
      <div className="divide-y divide-navy-700/30">
        {player.props.map((prop) => (
          <PropProgressRow
            key={`${player.player}-${prop.stat}`}
            prop={prop}
            myBet={bets[prop.stat]}
            onSetBet={setBet}
            customLine={customLines[prop.stat] ?? null}
            onSetLine={setLine}
          />
        ))}
      </div>
    </div>
  )
}

function GameTrackerCard({ game, statFilter, searchQ, pinnedPlayers = [], onTogglePin = () => {} }) {
  const isLive  = game.is_live
  const isFinal = game.is_final

  const players = game.players.filter(p => {
    if (searchQ && !p.player.toLowerCase().includes(searchQ.toLowerCase())) return false
    if (statFilter !== 'all') {
      return p.props.some(pr => pr.stat === statFilter)
    }
    return true
  }).map(p => ({
    ...p,
    props: statFilter !== 'all'
      ? p.props.filter(pr => pr.stat === statFilter)
      : p.props,
  }))

  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className={`border rounded-xl overflow-hidden ${
      isLive ? 'border-green-700/60 shadow-[0_0_12px_rgba(74,222,128,0.06)]' : 'border-navy-700'
    }`}>
      {/* Game header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full bg-navy-800 px-4 py-3 flex items-center justify-between hover:bg-navy-700/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {isLive && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse-slow" />
              <span className="text-xs font-bold text-green-400">LIVE</span>
            </span>
          )}
          {isFinal && <span className="text-xs text-gray-500 font-medium">Final</span>}
          {!isLive && !isFinal && (
            <span className="text-xs text-blue-400/60 font-medium">
              {game.commence_time
                ? new Date(game.commence_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : 'Scheduled'}
            </span>
          )}

          <span className="text-sm font-bold text-gray-100">
            {game.away_abbr} <span className="text-navy-500 font-normal">@</span> {game.home_abbr}
          </span>

          {(isLive || isFinal) && (
            <span className="text-lg font-bold tabular-nums text-gray-200">
              {game.away_score} <span className="text-navy-600">–</span> {game.home_score}
            </span>
          )}

          {isLive && game.period > 0 && (
            <span className="text-xs text-green-400/70">
              Q{game.period} {game.clock}
            </span>
          )}
        </div>

      </button>

      {/* Scoreboard + Play-by-Play */}
      {!collapsed && (
        <div className="bg-navy-900/20 px-4 pt-3 pb-1">
          <GameScoreboard eventId={game.event_id} isLive={isLive} />
        </div>
      )}

      {/* Players grid */}
      {!collapsed && (
        <div className="bg-navy-900/30 p-4 pt-2">
          {players.length === 0 ? (
            <p className="text-xs text-navy-500 text-center py-4">No players with lines for this filter.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {players.map((p) => (
                <PlayerTrackerCard key={p.player} player={p} isLive={isLive}
                  isPinned={pinnedPlayers.includes(p.player)}
                  onTogglePin={onTogglePin} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Game Scoreboard (ESPN play-by-play)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ESPN-style Scoreboard + Shot Chart
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Live Court Animation
// ---------------------------------------------------------------------------

// Classify a play into animation type
function classifyPlay(play) {
  const text  = (play.text || '').toLowerCase()
  const shoot = play.is_shooting === true
  const score = play.is_scoring  === true
  const pts   = play.score_value || 0

  // Non-shooting plays
  if (!shoot) {
    if (text.includes('rebound'))                           return 'rebound'
    if (text.includes('block'))                             return 'block'
    if (text.includes('foul'))                              return 'foul'
    if (text.includes('turnover') || text.includes('steal'))return 'turnover'
    if (text.includes('substitut') || text.includes('enters') || text.includes('replaces')) return 'sub'
    if (text.includes('timeout'))                           return 'timeout'
    if (text.includes('free throw')) return score ? 'ft_made' : 'ft_miss'
    return 'other'
  }
  // Shooting plays
  if (score) return pts === 3 ? 'three_made' : pts === 1 ? 'ft_made' : 'two_made'
  return (text.includes('three') || text.includes('3-point') || text.includes('3pt') || pts === 3)
    ? 'three_miss' : 'two_miss'
}

// ESPN court coords → SVG pixels (full court top-down)
// ESPN: x=0..50 = court width (bottom sideline → top sideline)
//       y=0..47 = distance from attacking basket (0=at basket, 47=halfcourt)
// SVG:  x=BL..BR horizontal, y=BT..BB vertical, CY=center
// Side: 'left'  = team attacks LEFT basket (away, basket at lBasketX)
//       'right' = team attacks RIGHT basket (home, basket at rBasketX)
function coordToSvg(espnX, espnY, side) {
  const BL = 30, BR = 910, BT = 25, BB = 475
  const CH = BB - BT   // 450px court height
  const halfW = (BR - BL) / 2   // 440px half-court width

  // x=0 is bottom sideline, x=50 is top sideline → map to SVG y
  const svgY = BT + (espnX / 50) * CH

  // y=0 is at basket, y=47 is halfcourt
  const depthRatio = Math.min(espnY / 47, 1)

  let svgX
  if (side === 'left') {
    // Basket at BL+52 ≈ 82, halfcourt at mid=470
    svgX = BL + 52 + depthRatio * (halfW - 52)
  } else {
    // Basket at BR-52 ≈ 858, halfcourt at mid=470
    svgX = BR - 52 - depthRatio * (halfW - 52)
  }

  return {
    sx: Math.max(BL + 5, Math.min(BR - 5, svgX)),
    sy: Math.max(BT + 5, Math.min(BB - 5, svgY)),
  }
}

function extractPlayMeta(play, kind) {
  const text = String(play?.text || '').trim()
  const lower = text.toLowerCase()
  const shotKind = kind || classifyPlay(play || {})

  const explicitName = String(play?.athlete_name || '').trim()
  let shooter = explicitName
  if (!shooter) {
    const m = text.match(/^([A-Za-z.'\-\s]+?)\s+(makes|misses|made|missed)\b/i)
    if (m?.[1]) shooter = m[1].trim()
  }

  const isShot = shotKind.includes('made') || shotKind.includes('miss')
  const isThree = shotKind.includes('three') || lower.includes('3-point') || lower.includes('three point')
  const isFt = shotKind.includes('ft_') || lower.includes('free throw')
  const shotType = isFt ? 'FT' : isThree ? '3PT' : isShot ? '2PT' : ''
  const shotCode = isFt ? 'FT' : isThree ? '3' : isShot ? '2' : ''
  const made = shotKind.includes('made')
  const missed = shotKind.includes('miss')
  const outcome = made ? 'MADE' : missed ? 'MISSED' : ''
  const resultLabel = isShot ? `${shotCode} ${made ? 'MADE' : 'MISS'}` : ''
  const assistMatch = text.match(/\(([^()]+?)\s+assists?\)/i)
  const assist = assistMatch?.[1]?.trim() || ''
  const blockMatch = text.match(/blocked by\s+([A-Za-z.'\-\s]+)/i)
  const blocker = blockMatch?.[1]?.trim() || ''
  const isBlocked = lower.includes('blocked') || !!blocker
  const isAndOne = !!(isShot && made && (lower.includes('and one') || (lower.includes('foul') && !isFt)))
  const reboundMatch = text.match(/^([A-Za-z.'\-\s]+?)\s+(defensive|offensive)?\s*rebound/i)
  const rebounder = reboundMatch?.[1]?.trim() || ''
  const reboundType = (reboundMatch?.[2] || '').toLowerCase()

  let headline = text
  if (isShot) {
    headline = `${shooter || (play?.team_abbr || 'Team')} ${shotType} ${outcome}${assist ? ` · AST ${assist}` : ''}${isBlocked && blocker ? ` · BLK ${blocker}` : ''}`
  } else if (rebounder) {
    headline = `${rebounder} ${reboundType ? reboundType.toUpperCase() + ' ' : ''}REBOUND`
  } else if (lower.includes('assist') && assist) {
    headline = `AST ${assist}`
  }

  return {
    shooter,
    assist,
    blocker,
    isBlocked,
    isAndOne,
    rebounder,
    reboundType,
    isShot,
    shotType,
    shotCode,
    made,
    missed,
    outcome,
    resultLabel,
    headline,
  }
}

function hexToRgba(hex, alpha = 1) {
  const clean = (hex || '').replace('#', '')
  if (clean.length !== 6) return `rgba(99, 102, 241, ${alpha})`
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const PLAY_COLORS = {
  three_made:  { ball: '#22c55e', ring: '#16a34a', label: '3 Points!',   bg: 'rgba(34,197,94,0.9)' },
  two_made:    { ball: '#22c55e', ring: '#16a34a', label: '2 Points!',   bg: 'rgba(34,197,94,0.9)' },
  ft_made:     { ball: '#22c55e', ring: '#16a34a', label: 'Free Throw!', bg: 'rgba(34,197,94,0.9)' },
  three_miss:  { ball: '#ef4444', ring: '#dc2626', label: 'Miss (3PT)',  bg: 'rgba(239,68,68,0.9)'  },
  two_miss:    { ball: '#ef4444', ring: '#dc2626', label: 'Miss',        bg: 'rgba(239,68,68,0.9)'  },
  ft_miss:     { ball: '#ef4444', ring: '#dc2626', label: 'FT Miss',     bg: 'rgba(239,68,68,0.9)'  },
  rebound:     { ball: '#f59e0b', ring: '#d97706', label: 'Rebound',     bg: 'rgba(245,158,11,0.9)' },
  block:       { ball: '#f43f5e', ring: '#e11d48', label: 'Block',       bg: 'rgba(244,63,94,0.9)' },
  foul:        { ball: '#a855f7', ring: '#9333ea', label: 'Foul',        bg: 'rgba(168,85,247,0.9)' },
  turnover:    { ball: '#f97316', ring: '#ea580c', label: 'Turnover',    bg: 'rgba(249,115,22,0.9)' },
  sub:         { ball: '#6b7280', ring: '#4b5563', label: 'Sub',         bg: 'rgba(107,114,128,0.9)'},
  timeout:     { ball: '#6b7280', ring: '#4b5563', label: 'Timeout',     bg: 'rgba(107,114,128,0.9)'},
  other:       { ball: '#6b7280', ring: '#4b5563', label: '',            bg: 'rgba(107,114,128,0.9)'},
}

export function LiveCourtAnimation({ eventId, isLive, home, away, demoData = null }) {
  const lastSeqRef    = useRef(0)
  const animQueueRef  = useRef([])
  const animTimerRef  = useRef(null)
  const animKeyRef    = useRef(0)

  const [currentPlay,  setCurrentPlay]  = useState(null)
  const [phase,        setPhase]        = useState('idle')   // 'arc' | 'impact' | 'idle'
  const [recentPlays,  setRecentPlays]  = useState([])

  const homeColor = `#${home.color || '1d428a'}`
  const awayColor = `#${away.color || '333333'}`

  const { data: apiData } = useApi(
    `/api/nba/game-feed/${eventId}`,
    { interval: demoData ? 0 : (isLive ? 8000 : 0) }
  )
  const data = demoData || apiData

  // ── Court constants ────────────────────────────────────────────────────────
  const VW = 940, VH = 500
  const BL = 30, BR = 910, BT = 25, BB = 475, CY = 250, mid = VW / 2
  const paintW = 160, paintH = 190
  const lPaintX = BL
  const rPaintX = BR - paintH
  const lPaintY = CY - paintW / 2
  const ftR = 60, arcR = 237
  const c3Y1 = BT + 30, c3Y2 = BB - 30
  const lBasketX = BL + 52, rBasketX = BR - 52, rimR = 18, raR = 40

  // ── Detect new plays ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!data?.plays?.length) return
    const seq = data.last_sequence || 0

    // Demo mode can loop sequence numbers back to start.
    // Reset internal refs so animation continues on every loop.
    if (demoData && seq < lastSeqRef.current) {
      lastSeqRef.current = 0
      animQueueRef.current = []
      if (animTimerRef.current) {
        clearTimeout(animTimerRef.current)
        animTimerRef.current = null
      }
      setCurrentPlay(null)
      setPhase('idle')
    }

    if (seq <= lastSeqRef.current && lastSeqRef.current > 0) return

    const isFirst = lastSeqRef.current === 0
    lastSeqRef.current = seq

    const toShow = isFirst
      ? [data.plays[0]]
      : (demoData ? [data.plays[0]] : data.plays.filter((_, i) => i < 3))
    toShow.forEach(p => animQueueRef.current.push(p))
    setRecentPlays(data.plays.slice(0, 6))
    if (!animTimerRef.current) runNext()
  }, [data, demoData])

  const runNext = () => {
    const play = animQueueRef.current.shift()
    if (!play) { setPhase('idle'); setCurrentPlay(null); return }

    animKeyRef.current++
    setCurrentPlay(play)
    setPhase('arc')

    // Arc duration: ~900ms, then impact for 1400ms, then next
    animTimerRef.current = setTimeout(() => {
      setPhase('impact')
      animTimerRef.current = setTimeout(() => {
        animTimerRef.current = null
        runNext()
      }, 1400)
    }, 900)
  }

  useEffect(() => () => clearTimeout(animTimerRef.current), [])

  // ── Compute shot geometry ─────────────────────────────────────────────────
  const getPlayGeometry = (play) => {
    if (!play) return null
    const kind    = classifyPlay(play)
    const isHome  = play.team_id === home.id
    const isShooting = kind.includes('made') || kind.includes('miss')

    // Basket is the TARGET of every shot
    const basketX = isHome ? rBasketX : lBasketX
    const basketY = CY

    // Default shot origin: mid-range on correct half
    let fromX = isHome ? mid + 120 : mid - 120
    let fromY = CY

    // Use ESPN coordinates if available
    if (play.x != null && play.y != null) {
      const side = isHome ? 'right' : 'left'
      const { sx, sy } = coordToSvg(play.x, play.y, side)
      fromX = sx
      fromY = sy
    }

    // Arc control point — higher arc for longer shots
    const dist = Math.sqrt((basketX - fromX) ** 2 + (basketY - fromY) ** 2)
    const arcH  = Math.min(200, Math.max(70, dist * 0.6))
    const cpX   = (fromX + basketX) / 2
    const cpY   = Math.min(fromY, basketY) - arcH

    const trailPath = `M ${fromX} ${fromY} Q ${cpX} ${cpY} ${basketX} ${basketY}`

    return { kind, isHome, fromX, fromY, basketX, basketY, cpX, cpY, arcH, trailPath, dist }
  }

  const geo      = getPlayGeometry(currentPlay)
  const kind     = geo?.kind || 'other'
  const colors   = PLAY_COLORS[kind] || PLAY_COLORS.other
  const isScore  = kind.includes('made') || kind === 'ft_made'
  const isMiss   = kind.includes('miss')
  const isShooting = isScore || isMiss
  const animKey  = animKeyRef.current
  const dur      = '0.85s'
  const playMeta = extractPlayMeta(currentPlay, kind)
  const missBounceX = geo ? geo.basketX + (geo.isHome ? -72 : 72) : 0
  const missBounceY = geo ? geo.basketY - 26 : 0
  const missBouncePath = geo
    ? `M ${geo.basketX} ${geo.basketY} Q ${geo.basketX + (geo.isHome ? -24 : 24)} ${geo.basketY - 54} ${missBounceX} ${missBounceY}`
    : ''
  const missShadowPath = geo
    ? `M ${geo.basketX} ${geo.basketY + 14} Q ${geo.basketX + (geo.isHome ? -18 : 18)} ${geo.basketY + 6} ${missBounceX} ${missBounceY + 14}`
    : ''
  const reboundX = currentPlay?.team_id === home.id ? (rPaintX + 42) : (lPaintX + paintH - 42)
  const reboundY = CY + ((animKey % 2 === 0) ? 56 : -56)
  const showStatsOverlay = (
    !!currentPlay && phase === 'impact' && (
      kind === 'timeout'
      || kind === 'sub'
      || kind === 'foul'
      || String(currentPlay?.text || '').toLowerCase().includes('timeout')
    )
  )
  const possession = data?.possession || {}
  const possSideById = possession.team_id === home.id ? 'home' : possession.team_id === away.id ? 'away' : ''
  const possSide = possession.side || possSideById
  const possAbbr = possession.team_abbr || (possSide === 'home' ? home.abbr : possSide === 'away' ? away.abbr : '')
  const possColor = possSide === 'home' ? homeColor : possSide === 'away' ? awayColor : null

  const linescore = data?.linescore || {}
  const awayLine = Array.isArray(linescore.away) && linescore.away.length ? linescore.away : ['-', '-', '-', '-']
  const homeLine = Array.isArray(linescore.home) && linescore.home.length ? linescore.home : ['-', '-', '-', '-']

  const teamStats = data?.team_stats || {}
  const awayStats = teamStats[away.abbr] || {}
  const homeStats = teamStats[home.abbr] || {}
  const pickStat = (obj, terms) => {
    const entries = Object.entries(obj || {})
    const hit = entries.find(([k]) => terms.some(t => String(k).toLowerCase().includes(t)))
    return hit ? String(hit[1]) : '--'
  }
  const statRows = [
    {
      label: 'Tiros Libres',
      awayPct: pickStat(awayStats, ['free throw %', 'free throws %']),
      awayRaw: pickStat(awayStats, ['free throws']),
      homePct: pickStat(homeStats, ['free throw %', 'free throws %']),
      homeRaw: pickStat(homeStats, ['free throws']),
    },
    {
      label: 'Tiros de 2 Puntos',
      awayPct: pickStat(awayStats, ['2pt %', '2 point %']),
      awayRaw: pickStat(awayStats, ['2pt']),
      homePct: pickStat(homeStats, ['2pt %', '2 point %']),
      homeRaw: pickStat(homeStats, ['2pt']),
    },
    {
      label: 'Tiros de 3 Puntos',
      awayPct: pickStat(awayStats, ['3pt %', 'three point %']),
      awayRaw: pickStat(awayStats, ['3pt', 'three pointers']),
      homePct: pickStat(homeStats, ['3pt %', 'three point %']),
      homeRaw: pickStat(homeStats, ['3pt', 'three pointers']),
    },
  ]

  const shooterTrend = useMemo(() => {
    const shooter = playMeta?.shooter
    if (!shooter || !Array.isArray(data?.plays)) return null
    const key = shooter.toLowerCase()
    const shots = data.plays
      .map((p) => ({ p, k: classifyPlay(p), m: extractPlayMeta(p, classifyPlay(p)) }))
      .filter(({ m }) => m.isShot && (m.shooter || '').toLowerCase() === key)

    if (!shots.length) return null
    const last5 = shots.slice(0, 5)
    const made5 = last5.filter(({ m }) => m.made).length

    const last3pt = shots.filter(({ m }) => m.shotType === '3PT').slice(0, 5)
    const made3 = last3pt.filter(({ m }) => m.made).length

    let streakType = ''
    let streakLen = 0
    for (const s of shots) {
      if (!streakType) {
        streakType = s.m.made ? 'made' : 'miss'
        streakLen = 1
      } else if ((s.m.made && streakType === 'made') || (!s.m.made && streakType === 'miss')) {
        streakLen += 1
      } else {
        break
      }
    }

    return {
      shooter,
      last5,
      made5,
      attempts5: last5.length,
      made3,
      attempts3: last3pt.length,
      streakType,
      streakLen,
    }
  }, [data?.plays, playMeta?.shooter])

  const runInfo = useMemo(() => {
    if (!Array.isArray(data?.plays) || data.plays.length < 2) return null
    const chrono = [...data.plays].reverse()
    let prevAway = Number(chrono[0]?.away_score || 0)
    let prevHome = Number(chrono[0]?.home_score || 0)
    const scoring = []

    for (let i = 1; i < chrono.length; i++) {
      const p = chrono[i]
      const awayNow = Number(p?.away_score || 0)
      const homeNow = Number(p?.home_score || 0)
      const dAway = awayNow - prevAway
      const dHome = homeNow - prevHome
      if (dAway > 0 || dHome > 0) {
        const team = dHome > dAway ? 'home' : dAway > dHome ? 'away' : (p?.team_id === home.id ? 'home' : 'away')
        scoring.push({ team, pts: Math.max(dAway, dHome, Number(p?.score_value || 0), 1) })
      }
      prevAway = awayNow
      prevHome = homeNow
    }

    if (!scoring.length) return null
    const lastTeam = scoring[scoring.length - 1].team
    let points = 0
    for (let i = scoring.length - 1; i >= 0; i--) {
      if (scoring[i].team !== lastTeam) break
      points += scoring[i].pts
    }
    if (points < 2) return null
    return {
      team: lastTeam,
      points,
      abbr: lastTeam === 'home' ? home.abbr : away.abbr,
      color: lastTeam === 'home' ? homeColor : awayColor,
    }
  }, [data?.plays, home.id, home.abbr, away.abbr, homeColor, awayColor])

  return (
    <div className="space-y-3">
      <div className="rounded-xl overflow-hidden border border-blue-900/80 bg-[#0b1f3d] shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
        <div className="px-4 py-2.5 bg-[#132c52] border-b border-blue-900/80 flex items-center justify-between">
          <span className="text-sm font-bold text-white">Partido en vivo</span>
          {isLive && <span className="text-[11px] font-bold text-cyan-300">EN DIRECTO</span>}
        </div>
        <div className="px-3 py-2 bg-[#0f2548] border-b border-blue-900/70">
          <div className="grid grid-cols-7 text-[11px] text-blue-200/85">
            <span className="col-span-2">4x12 Min</span>
            <span className="text-center">1</span>
            <span className="text-center">2</span>
            <span className="text-center">3</span>
            <span className="text-center">4</span>
            <span className="text-center font-semibold">T</span>
          </div>
          <div className="grid grid-cols-7 text-sm text-white mt-1">
            <span className="col-span-2 font-semibold">{away.name || away.abbr}</span>
            <span className="text-center">{awayLine[0]}</span>
            <span className="text-center">{awayLine[1]}</span>
            <span className="text-center">{awayLine[2]}</span>
            <span className="text-center">{awayLine[3]}</span>
            <span className="text-center font-bold">{away.score ?? 0}</span>
          </div>
          <div className="grid grid-cols-7 text-sm text-white mt-0.5">
            <span className="col-span-2 font-semibold">{home.name || home.abbr}</span>
            <span className="text-center">{homeLine[0]}</span>
            <span className="text-center">{homeLine[1]}</span>
            <span className="text-center">{homeLine[2]}</span>
            <span className="text-center">{homeLine[3]}</span>
            <span className="text-center font-bold">{home.score ?? 0}</span>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          {isLive
            ? <><span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-slow inline-block" />
                <span className="text-xs font-bold text-red-400">LIVE</span></>
            : <span className="text-xs text-gray-600">Showing last plays</span>
          }
          {currentPlay && (
            <span className="text-xs text-gray-300 ml-2 truncate max-w-xs font-medium">{playMeta.headline || currentPlay.text}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {runInfo && (
            <span className="text-[11px] font-bold px-2 py-0.5 rounded border"
              style={{
                color: runInfo.color,
                borderColor: `${runInfo.color}99`,
                backgroundColor: `${runInfo.color}20`,
              }}>
              RUN {runInfo.abbr} {runInfo.points}-0
            </span>
          )}
          {possSide && possColor && (
            <span className="text-xs font-semibold flex items-center gap-1.5" style={{ color: possColor }}>
              <span className="w-1.5 h-1.5 rounded-full inline-block animate-pulse-slow" style={{ backgroundColor: possColor }} />
              {possAbbr || 'Team'} ball
            </span>
          )}
          <span className="text-xs text-gray-700">Updates every 8s</span>
        </div>
      </div>

      {currentPlay && (
        <div key={currentPlay.sequence_number || currentPlay.wallclock}
          className="rounded-lg border border-blue-900/70 bg-[#0f274d]/80 px-3 py-2 flex items-center justify-between gap-3 transition-all duration-500">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full"
                style={{
                  color: colors.ball,
                  backgroundColor: `${colors.ball}22`,
                  border: `1px solid ${colors.ball}55`,
                }}>
                {playMeta.isShot ? playMeta.resultLabel : (colors.label || 'PLAY').toUpperCase()}
              </span>
              <p className="text-xs text-blue-100 truncate font-medium">{playMeta.headline || currentPlay.text}</p>
              {playMeta.assist && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 shrink-0">
                  AST: {playMeta.assist}
                </span>
              )}
              {playMeta.rebounder && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 shrink-0">
                  REB: {playMeta.rebounder}
                </span>
              )}
              {playMeta.blocker && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-rose-500/50 bg-rose-500/15 text-rose-200 shrink-0">
                  BLK: {playMeta.blocker}
                </span>
              )}
            </div>
            {shooterTrend && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-blue-200/80">Form</span>
                <div className="flex items-center gap-1">
                  {shooterTrend.last5.map(({ m }, idx) => (
                    <span key={`${m.shooter || 'p'}-${idx}`} className={`w-1.5 h-1.5 rounded-full ${m.made ? 'bg-green-400' : 'bg-red-400'}`} />
                  ))}
                </div>
                <span className="text-[10px] text-blue-100/85 font-semibold">
                  {shooterTrend.made5}/{shooterTrend.attempts5}
                </span>
                {shooterTrend.attempts3 > 0 && (
                  <span className="text-[10px] text-cyan-200/90">3PT {shooterTrend.made3}/{shooterTrend.attempts3}</span>
                )}
                {shooterTrend.streakLen >= 2 && (
                  <span className={`text-[10px] font-bold ${shooterTrend.streakType === 'made' ? 'text-green-300' : 'text-red-300'}`}>
                    {shooterTrend.streakType === 'made' ? 'HOT' : 'COLD'} x{shooterTrend.streakLen}
                  </span>
                )}
              </div>
            )}
          </div>
          <span className="text-xs text-blue-200/80 tabular-nums shrink-0">
            Q{currentPlay.period} {currentPlay.clock}
          </span>
        </div>
      )}

      {/* ── Court ── */}
      <div className="rounded-xl overflow-hidden border border-gray-800 relative" style={{ background: '#0a0e17' }}>
        {showStatsOverlay && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-[320px] max-w-[84%] bg-[#8e6a3f]/90 border border-[#c89f63]/70 rounded-2xl px-3 py-2.5 shadow-[0_8px_20px_rgba(0,0,0,0.4)] backdrop-blur-[1px] animate-fade-in-up">
            <p className="text-center text-[13px] text-white font-bold mb-1">Estadisticas De Puntuacion</p>
            {statRows.map((r) => (
              <div key={r.label} className="grid grid-cols-3 gap-2 items-center text-xs text-white mt-1">
                <div className="text-left">
                  <p className="font-bold text-blue-200">{r.awayPct}</p>
                  <p className="text-blue-100/85">{r.awayRaw}</p>
                </div>
                <div className="text-center font-semibold text-white/95">{r.label}</div>
                <div className="text-right">
                  <p className="font-bold text-red-200">{r.homePct}</p>
                  <p className="text-red-100/85">{r.homeRaw}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full block"
          xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="lcWood" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#d4a855" />
              <stop offset="50%"  stopColor="#c49040" />
              <stop offset="100%" stopColor="#a8742a" />
            </linearGradient>
            <radialGradient id="lcGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor={colors.ball} stopOpacity="0.7" />
              <stop offset="100%" stopColor={colors.ball} stopOpacity="0" />
            </radialGradient>
            <linearGradient id="awayPossGlow" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={hexToRgba(awayColor, 0.3)} />
              <stop offset="55%" stopColor={hexToRgba(awayColor, 0.12)} />
              <stop offset="100%" stopColor={hexToRgba(awayColor, 0)} />
            </linearGradient>
            <linearGradient id="homePossGlow" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor={hexToRgba(homeColor, 0.3)} />
              <stop offset="55%" stopColor={hexToRgba(homeColor, 0.12)} />
              <stop offset="100%" stopColor={hexToRgba(homeColor, 0)} />
            </linearGradient>
            <linearGradient id="awayAttackBeam" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor={hexToRgba(awayColor, 0)} />
              <stop offset="100%" stopColor={hexToRgba(awayColor, 0.52)} />
            </linearGradient>
            <linearGradient id="homeAttackBeam" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={hexToRgba(homeColor, 0)} />
              <stop offset="100%" stopColor={hexToRgba(homeColor, 0.52)} />
            </linearGradient>
            <filter id="lcShadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="3" stdDeviation="5" floodOpacity="0.5" />
            </filter>
            <filter id="lcGlow2" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>

          {/* Floor */}
          <rect x={BL} y={BT} width={BR - BL} height={BB - BT} fill="url(#lcWood)" />
          {possSide === 'away' && possColor && (
            <rect x={BL} y={BT} width={mid - BL} height={BB - BT}
              fill="url(#awayPossGlow)" opacity="0.95" />
          )}
          {possSide === 'home' && possColor && (
            <rect x={mid} y={BT} width={BR - mid} height={BB - BT}
              fill="url(#homePossGlow)" opacity="0.95" />
          )}
          {possSide === 'away' && possColor && (
            <rect x={BL} y={BT} width={mid - BL} height={BB - BT}
              fill="url(#awayAttackBeam)" opacity="0.45">
              <animate attributeName="opacity" values="0.25;0.58;0.25" dur="1.1s" repeatCount="indefinite" />
            </rect>
          )}
          {possSide === 'home' && possColor && (
            <rect x={mid} y={BT} width={BR - mid} height={BB - BT}
              fill="url(#homeAttackBeam)" opacity="0.45">
              <animate attributeName="opacity" values="0.25;0.58;0.25" dur="1.1s" repeatCount="indefinite" />
            </rect>
          )}
          {possSide && possColor && (
            <g opacity="0.72">
              {[0, 1, 2].map((i) => {
                const baseX = possSide === 'home' ? (mid + 78 + i * 92) : (mid - 78 - i * 92)
                const pts = possSide === 'home'
                  ? `${baseX},${CY} ${baseX - 24},${CY - 14} ${baseX - 24},${CY + 14}`
                  : `${baseX},${CY} ${baseX + 24},${CY - 14} ${baseX + 24},${CY + 14}`
                return (
                  <polygon key={`attack-${i}`} points={pts} fill={possColor} opacity="0.18">
                    <animate attributeName="opacity" values="0.08;0.45;0.08" dur="1s" begin={`${i * 0.14}s`} repeatCount="indefinite" />
                  </polygon>
                )
              })}
            </g>
          )}
          {Array.from({ length: 18 }).map((_, i) => (
            <line key={i} x1={BL} y1={BT + i * ((BB - BT) / 17)} x2={BR} y2={BT + i * ((BB - BT) / 17)}
              stroke="rgba(0,0,0,0.05)" strokeWidth="1" />
          ))}

          {/* Court lines */}
          <g stroke="rgba(255,255,255,0.75)" strokeWidth="2.5" fill="none">
            <rect x={BL} y={BT} width={BR - BL} height={BB - BT} />
            <line x1={mid} y1={BT} x2={mid} y2={BB} />
            <circle cx={mid} cy={CY} r={60} />
            <rect x={BL} y={lPaintY} width={paintH} height={paintW} />
            <path d={`M ${BL+paintH-ftR} ${CY} A ${ftR} ${ftR} 0 0 1 ${BL+paintH+ftR} ${CY}`} />
            <path d={`M ${BL+paintH-ftR} ${CY} A ${ftR} ${ftR} 0 0 0 ${BL+paintH+ftR} ${CY}`} strokeDasharray="10 6" />
            <line x1={BL} y1={c3Y1} x2={BL+170} y2={c3Y1} />
            <line x1={BL} y1={c3Y2} x2={BL+170} y2={c3Y2} />
            <path d={`M ${BL+170} ${c3Y1} A ${arcR} ${arcR} 0 0 1 ${BL+170} ${c3Y2}`} />
            <path d={`M ${lBasketX} ${CY-raR} A ${raR} ${raR} 0 0 1 ${lBasketX} ${CY+raR}`} />
            <rect x={BR-paintH} y={lPaintY} width={paintH} height={paintW} />
            <path d={`M ${BR-paintH+ftR} ${CY} A ${ftR} ${ftR} 0 0 1 ${BR-paintH-ftR} ${CY}`} />
            <path d={`M ${BR-paintH+ftR} ${CY} A ${ftR} ${ftR} 0 0 0 ${BR-paintH-ftR} ${CY}`} strokeDasharray="10 6" />
            <line x1={BR} y1={c3Y1} x2={BR-170} y2={c3Y1} />
            <line x1={BR} y1={c3Y2} x2={BR-170} y2={c3Y2} />
            <path d={`M ${BR-170} ${c3Y1} A ${arcR} ${arcR} 0 0 0 ${BR-170} ${c3Y2}`} />
            <path d={`M ${rBasketX} ${CY-raR} A ${raR} ${raR} 0 0 0 ${rBasketX} ${CY+raR}`} />
          </g>

          {/* Paint fills */}
          <rect x={BL} y={lPaintY} width={paintH} height={paintW} fill="rgba(0,0,0,0.1)" />
          <rect x={BR-paintH} y={lPaintY} width={paintH} height={paintW} fill="rgba(0,0,0,0.1)" />

          {/* Backboards */}
          <rect x={BL+8} y={CY-34} width={6} height={68} fill="rgba(255,255,255,0.92)" rx="1" />
          <rect x={BR-14} y={CY-34} width={6} height={68} fill="rgba(255,255,255,0.92)" rx="1" />

          {/* Rims */}
          <circle cx={lBasketX} cy={CY} r={rimR} fill="none" stroke="#e05020" strokeWidth="4.5" />
          <circle cx={rBasketX} cy={CY} r={rimR} fill="none" stroke="#e05020" strokeWidth="4.5" />

          {/* Watermarks */}
          <text x={mid/2+BL/2} y={CY+12} textAnchor="middle" fill={awayColor} opacity="0.1" fontSize="80" fontWeight="900">{away.abbr}</text>
          <text x={mid+(BR-mid)/2} y={CY+12} textAnchor="middle" fill={homeColor} opacity="0.1" fontSize="80" fontWeight="900">{home.abbr}</text>

          {/* ── Shooter origin: headshot + ripple + score label ── */}
          {geo && isShooting && (currentPlay) && (
            <g key={`origin-${animKey}`}>
              {/* Ripple ring */}
              <circle cx={geo.fromX} cy={geo.fromY} r="12"
                fill="none" stroke={geo.isHome ? homeColor : awayColor} strokeWidth="2.5">
                <animate attributeName="r" from="12" to="50" dur="0.7s" fill="freeze" />
                <animate attributeName="opacity" from="0.9" to="0" dur="0.7s" fill="freeze" />
              </circle>
              <circle cx={geo.fromX} cy={geo.fromY} r="8"
                fill="none" stroke={geo.isHome ? homeColor : awayColor} strokeWidth="1.5" opacity="0.4">
                <animate attributeName="r" from="8" to="35" dur="0.9s" begin="0.1s" fill="freeze" />
                <animate attributeName="opacity" from="0.5" to="0" dur="0.9s" begin="0.1s" fill="freeze" />
              </circle>

              {/* Player headshot at shot origin */}
              {currentPlay.headshot && (
                <g>
                  <circle cx={geo.fromX} cy={geo.fromY - 38} r={22}
                    fill={geo.isHome ? homeColor : awayColor}
                    stroke="white" strokeWidth="2.5" opacity="0.95" />
                  <image href={currentPlay.headshot}
                    x={geo.fromX - 22} y={geo.fromY - 60}
                    width="44" height="50"
                    preserveAspectRatio="xMidYMin slice"
                    style={{ clipPath: 'circle(22px at 22px 22px)' }} />
                  {/* Name label */}
                  <rect x={geo.fromX - 38} y={geo.fromY - 14} width={76} height={14} rx="3"
                    fill="rgba(0,0,0,0.75)" />
                  <text x={geo.fromX} y={geo.fromY - 3}
                    textAnchor="middle" fill="white" fontSize="9" fontWeight="800"
                    fontFamily="Inter, system-ui, sans-serif">
                    {(currentPlay.athlete_name || '').split(' ').pop()}
                  </text>
                </g>
              )}

              {/* Score label at origin during arc */}
              {phase === 'arc' && isScore && (
                <g>
                  <rect x={geo.fromX - 28} y={geo.fromY + 10} width={56} height={18} rx="4"
                    fill={kind === 'three_made' ? 'rgba(168,85,247,0.9)' : 'rgba(34,197,94,0.9)'}>
                    <animate attributeName="opacity" from="0" to="1" dur="0.15s" fill="freeze" />
                  </rect>
                  <text x={geo.fromX} y={geo.fromY + 22}
                    textAnchor="middle" fill="white" fontSize="11" fontWeight="900"
                    fontFamily="Inter, system-ui, sans-serif">
                    {kind === 'three_made' ? '+3' : '+2'}
                    <animate attributeName="opacity" from="0" to="1" dur="0.15s" fill="freeze" />
                  </text>
                </g>
              )}
            </g>
          )}

          {/* ── Ball arc trail (dashed path) ── */}
          {geo && isShooting && phase !== 'idle' && (
            <path d={geo.trailPath}
              fill="none"
              stroke={isScore ? 'rgba(34,197,94,0.35)' : 'rgba(200,200,200,0.25)'}
              strokeWidth="2"
              strokeDasharray="8 5"
            />
          )}

          {/* ── Basketball arc (animateMotion along quadratic bezier) ── */}
          {geo && isShooting && phase === 'arc' && (
            <g key={`ball-${animKey}`} filter="url(#lcShadow)">
              {/* Basketball body */}
              <circle r={12} fill="#e8630a" stroke="#bf4300" strokeWidth="2">
                <animateMotion
                  dur={dur}
                  fill="freeze"
                  calcMode="spline"
                  keyTimes="0;1"
                  keySplines="0.25 0.1 0.25 1"
                  path={`M ${geo.fromX} ${geo.fromY} Q ${geo.cpX} ${geo.cpY} ${geo.basketX} ${geo.basketY}`}
                />
              </circle>
              {/* Horizontal seam */}
              <path d="M -12 0 Q 0 -15 12 0" fill="none" stroke="#bf4300" strokeWidth="1.5">
                <animateMotion
                  dur={dur} fill="freeze" calcMode="spline"
                  keyTimes="0;1" keySplines="0.25 0.1 0.25 1"
                  path={`M ${geo.fromX} ${geo.fromY} Q ${geo.cpX} ${geo.cpY} ${geo.basketX} ${geo.basketY}`}
                />
              </path>
              {/* Vertical seam */}
              <line x1="0" y1="-12" x2="0" y2="12" stroke="#bf4300" strokeWidth="1.5">
                <animateMotion
                  dur={dur} fill="freeze" calcMode="spline"
                  keyTimes="0;1" keySplines="0.25 0.1 0.25 1"
                  path={`M ${geo.fromX} ${geo.fromY} Q ${geo.cpX} ${geo.cpY} ${geo.basketX} ${geo.basketY}`}
                />
              </line>
              {/* Ball shadow on floor */}
              <ellipse rx={10} ry={4} fill="rgba(0,0,0,0.3)">
                <animateMotion
                  dur={dur} fill="freeze" calcMode="spline"
                  keyTimes="0;1" keySplines="0.25 0.1 0.25 1"
                  path={`M ${geo.fromX} ${geo.fromY + 14} Q ${(geo.fromX+geo.basketX)/2} ${(geo.fromY+geo.basketY)/2 + 14} ${geo.basketX} ${geo.basketY + 14}`}
                />
              </ellipse>
            </g>
          )}

          {/* ── Impact at basket ── */}
          {geo && isShooting && phase === 'impact' && (
            <g key={`impact-${animKey}`}>
              {/* Glow */}
              <circle cx={geo.basketX} cy={geo.basketY} r={50}
                fill="url(#lcGlow)" opacity="0.8">
                <animate attributeName="r" from="20" to="70" dur="0.5s" fill="freeze" />
                <animate attributeName="opacity" from="1" to="0" dur="1.4s" fill="freeze" />
              </circle>

              {/* Made: green ring burst + net flash */}
              {isScore && (
                <g>
                  <circle cx={geo.basketX} cy={geo.basketY} r={rimR}
                    fill="none" stroke="#22c55e" strokeWidth="4" opacity="0.9">
                    <animate attributeName="r" from={rimR} to={rimR+30} dur="0.6s" fill="freeze" />
                    <animate attributeName="opacity" from="1" to="0" dur="0.8s" fill="freeze" />
                  </circle>
                  {/* Net drop lines */}
                  {[-12,-6,0,6,12].map(dx => (
                    <line key={dx} x1={geo.basketX+dx} y1={geo.basketY+rimR}
                      x2={geo.basketX+dx*0.6} y2={geo.basketY+rimR+28}
                      stroke="rgba(255,255,255,0.5)" strokeWidth="1.2">
                      <animate attributeName="y2" from={geo.basketY+rimR}
                        to={geo.basketY+rimR+28} dur="0.4s" fill="freeze" />
                      <animate attributeName="opacity" from="0.8" to="0" begin="0.5s" dur="0.6s" fill="freeze" />
                    </line>
                  ))}

                  {kind === 'three_made' && (
                    <g>
                      <circle cx={geo.basketX} cy={geo.basketY} r={16}
                        fill="none" stroke="#22d3ee" strokeWidth="3" opacity="0.95">
                        <animate attributeName="r" from="16" to="54" dur="0.6s" fill="freeze" />
                        <animate attributeName="opacity" from="0.95" to="0" dur="0.6s" fill="freeze" />
                      </circle>
                      <circle cx={geo.basketX} cy={geo.basketY} r={24}
                        fill="none" stroke="#34d399" strokeWidth="2" opacity="0.8">
                        <animate attributeName="r" from="24" to="72" dur="0.75s" fill="freeze" />
                        <animate attributeName="opacity" from="0.8" to="0" dur="0.75s" fill="freeze" />
                      </circle>
                      <text x={geo.basketX} y={geo.basketY - 24}
                        textAnchor="middle" fill="#67e8f9" fontSize="16" fontWeight="900"
                        fontFamily="Inter, system-ui, sans-serif" letterSpacing="1.5">
                        SWISH
                        <animate attributeName="opacity" from="0" to="1" dur="0.15s" fill="freeze" />
                        <animate attributeName="opacity" from="1" to="0" begin="0.85s" dur="0.25s" fill="freeze" />
                      </text>
                    </g>
                  )}

                  {playMeta.isAndOne && (
                    <g>
                      <rect x={geo.basketX - 60} y={geo.basketY - 6} width={120} height={22} rx="6"
                        fill="rgba(253,224,71,0.92)" stroke="rgba(113,63,18,0.7)" strokeWidth="1.5">
                        <animate attributeName="opacity" from="0" to="1" dur="0.18s" fill="freeze" />
                        <animate attributeName="opacity" from="1" to="0" begin="0.95s" dur="0.25s" fill="freeze" />
                      </rect>
                      <text x={geo.basketX} y={geo.basketY + 9}
                        textAnchor="middle" fill="#422006" fontSize="12" fontWeight="900"
                        fontFamily="Inter, system-ui, sans-serif" letterSpacing="1.1">
                        AND-1
                        <animate attributeName="opacity" from="0" to="1" dur="0.18s" fill="freeze" />
                        <animate attributeName="opacity" from="1" to="0" begin="0.95s" dur="0.25s" fill="freeze" />
                      </text>
                    </g>
                  )}
                </g>
              )}

              {/* Miss: rim bounce (epic clang) */}
              {isMiss && (
                <g>
                  <circle cx={geo.basketX} cy={geo.basketY} r={rimR + 3}
                    fill="none" stroke="#ef4444" strokeWidth="3" opacity="0.9">
                    <animate attributeName="r" from={rimR + 3} to={rimR + 18} dur="0.35s" fill="freeze" />
                    <animate attributeName="opacity" from="0.9" to="0" dur="0.55s" fill="freeze" />
                  </circle>
                  <g filter="url(#lcShadow)">
                    <circle r={11} fill="#e8630a" stroke="#c44f05" strokeWidth="1.5">
                      <animateMotion
                        dur="0.55s"
                        fill="freeze"
                        calcMode="spline"
                        keyTimes="0;1"
                        keySplines="0.35 0.1 0.25 1"
                        path={missBouncePath}
                      />
                    </circle>
                    <ellipse rx={10} ry={4} fill="rgba(0,0,0,0.3)">
                      <animateMotion
                        dur="0.55s"
                        fill="freeze"
                        calcMode="spline"
                        keyTimes="0;1"
                        keySplines="0.35 0.1 0.25 1"
                        path={missShadowPath}
                      />
                    </ellipse>
                  </g>
                </g>
              )}

              {playMeta.isBlocked && (
                <g>
                  <rect x={geo.basketX - 88} y={geo.basketY - 60} width={176} height={24} rx="6"
                    fill="rgba(244,63,94,0.9)" stroke="rgba(136,19,55,0.9)" strokeWidth="1.3">
                    <animate attributeName="opacity" from="0" to="1" dur="0.15s" fill="freeze" />
                    <animate attributeName="opacity" from="1" to="0" begin="1s" dur="0.25s" fill="freeze" />
                  </rect>
                  <text x={geo.basketX} y={geo.basketY - 44}
                    textAnchor="middle" fill="white" fontSize="12" fontWeight="900"
                    fontFamily="Inter, system-ui, sans-serif">
                    {`BLOCKED${playMeta.blocker ? ` BY ${playMeta.blocker.split(' ').slice(-1)[0].toUpperCase()}` : ''}`}
                    <animate attributeName="opacity" from="0" to="1" dur="0.15s" fill="freeze" />
                    <animate attributeName="opacity" from="1" to="0" begin="1s" dur="0.25s" fill="freeze" />
                  </text>
                </g>
              )}

              {/* Ball at rest only when made */}
              {isScore && (
                <circle cx={geo.basketX} cy={geo.basketY} r={11}
                  fill="#e8630a" stroke="#c44f05" strokeWidth="1.5" filter="url(#lcShadow)" />
              )}

              {/* Player headshot */}
              {currentPlay?.headshot && (
                <g>
                  <circle cx={geo.basketX} cy={geo.basketY - 48} r={24}
                    fill={geo.isHome ? homeColor : awayColor}
                    stroke="white" strokeWidth="2.5">
                    <animate attributeName="r" from="0" to="24" dur="0.2s" fill="freeze" />
                  </circle>
                  <image href={currentPlay.headshot}
                    x={geo.basketX - 24} y={geo.basketY - 72}
                    width="48" height="48"
                    preserveAspectRatio="xMidYMin slice"
                    style={{ clipPath: 'circle(24px at 24px 24px)' }}>
                    <animate attributeName="opacity" from="0" to="1" dur="0.3s" fill="freeze" />
                  </image>
                </g>
              )}

              {/* Score label */}
              <g>
                <rect x={geo.basketX - 55} y={geo.basketY + 22} width={110} height={24} rx="5"
                  fill={isScore ? 'rgba(34,197,94,0.92)' : 'rgba(239,68,68,0.92)'}>
                  <animate attributeName="opacity" from="0" to="1" dur="0.2s" fill="freeze" />
                  <animate attributeName="opacity" from="1" to="0" begin="1s" dur="0.3s" fill="freeze" />
                </rect>
                <text x={geo.basketX} y={geo.basketY + 38}
                  textAnchor="middle" fill="white" fontSize="12" fontWeight="900"
                  fontFamily="Inter, system-ui, sans-serif">
                  {playMeta.isShot ? playMeta.resultLabel : colors.label}
                  <animate attributeName="opacity" from="0" to="1" dur="0.2s" fill="freeze" />
                  <animate attributeName="opacity" from="1" to="0" begin="1s" dur="0.3s" fill="freeze" />
                </text>
              </g>
            </g>
          )}

          {/* Non-shooting plays */}
          {currentPlay && !isShooting && phase === 'impact' && kind === 'rebound' && (
            <g key={`rebound-${animKey}`}>
              <circle cx={reboundX} cy={reboundY} r="16" fill="none" stroke="#f59e0b" strokeWidth="3">
                <animate attributeName="r" from="16" to="48" dur="0.55s" fill="freeze" />
                <animate attributeName="opacity" from="0.9" to="0" dur="0.7s" fill="freeze" />
              </circle>
              <g filter="url(#lcShadow)">
                <circle cx={reboundX} cy={reboundY} r="12" fill="#e8630a" stroke="#c44f05" strokeWidth="1.5">
                  <animate attributeName="cy" values={`${reboundY};${reboundY - 18};${reboundY}`} dur="0.45s" repeatCount="2" />
                </circle>
              </g>
              <rect x={reboundX - 90} y={reboundY - 46} width={180} height={24} rx="6"
                fill="rgba(245,158,11,0.92)" stroke="rgba(120,53,15,0.9)" strokeWidth="1.5">
                <animate attributeName="opacity" from="0" to="1" dur="0.15s" fill="freeze" />
                <animate attributeName="opacity" from="1" to="0" begin="1.05s" dur="0.25s" fill="freeze" />
              </rect>
              <text x={reboundX} y={reboundY - 30} textAnchor="middle" fill="white"
                fontSize="12" fontWeight="900" fontFamily="Inter, system-ui, sans-serif">
                {(playMeta.rebounder ? `${playMeta.rebounder} REBOUND` : 'REBOUND').slice(0, 36)}
                <animate attributeName="opacity" from="0" to="1" dur="0.15s" fill="freeze" />
                <animate attributeName="opacity" from="1" to="0" begin="1.05s" dur="0.25s" fill="freeze" />
              </text>
            </g>
          )}

          {currentPlay && !isShooting && phase === 'impact' && kind !== 'rebound' && (
            <g key={`notify-${animKey}`}>
              <rect x={mid - 130} y={CY - 20} width={260} height={40} rx="8"
                fill="rgba(0,0,0,0.82)" stroke="rgba(255,255,255,0.15)" strokeWidth="1">
                <animate attributeName="opacity" from="0" to="1" dur="0.2s" fill="freeze" />
                <animate attributeName="opacity" from="1" to="0" begin="1.1s" dur="0.2s" fill="freeze" />
              </rect>
              <text x={mid} y={CY + 5} textAnchor="middle" fill="white"
                fontSize="12" fontWeight="700" fontFamily="Inter, system-ui, sans-serif">
                {(playMeta.headline || currentPlay.text || '').slice(0, 54)}
                <animate attributeName="opacity" from="0" to="1" dur="0.2s" fill="freeze" />
                <animate attributeName="opacity" from="1" to="0" begin="1.1s" dur="0.2s" fill="freeze" />
              </text>
            </g>
          )}
        </svg>
      </div>

      {/* Recent plays */}
      <div className="space-y-1">
        <p className="text-xs text-gray-600 uppercase tracking-wider font-semibold px-1">Recent Plays</p>
        {recentPlays.length === 0 && (
          <p className="text-xs text-gray-600 text-center py-3">Waiting for live plays…</p>
        )}
        {recentPlays.map((play, i) => {
          const k = classifyPlay(play)
          const c = PLAY_COLORS[k] || PLAY_COLORS.other
          const col = play.team_id === home.id ? homeColor : awayColor
          const m = extractPlayMeta(play, k)
          return (
            <div key={play.sequence_number || `${play.wallclock}-${i}`} className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              i === 0 ? 'bg-white/8 border border-white/10' : 'bg-white/3'
            }`}>
              <div className="w-7 h-7 rounded-full overflow-hidden shrink-0 border-2"
                style={{ borderColor: col }}>
                {play.headshot
                  ? <img src={play.headshot} alt="" className="w-full h-full object-cover object-top" />
                  : <div className="w-full h-full flex items-center justify-center text-xs font-black text-white"
                      style={{ background: col }}>{(play.team_abbr || '').slice(0, 2)}</div>
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-200 truncate">{m.headline || play.text}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-gray-600">Q{play.period} · {play.clock}</p>
                  {m.isShot && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border font-bold"
                      style={{
                        color: m.made ? '#4ade80' : '#f87171',
                        borderColor: m.made ? '#14532d' : '#7f1d1d',
                        backgroundColor: m.made ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      }}>
                      {m.shooter ? `${m.shooter.split(' ').slice(-1)[0]} · ` : ''}{m.resultLabel}
                    </span>
                  )}
                  {m.assist && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 font-semibold">
                      AST {m.assist.split(' ').slice(-1)[0]}
                    </span>
                  )}
                  {m.rebounder && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 font-semibold">
                      REB {m.rebounder.split(' ').slice(-1)[0]}
                    </span>
                  )}
                  {m.blocker && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-rose-500/50 bg-rose-500/15 text-rose-200 font-semibold">
                      BLK {m.blocker.split(' ').slice(-1)[0]}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-xs font-bold tabular-nums shrink-0" style={{ color: c.ball }}>
                {play.away_score}–{play.home_score}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── On-Court Players (ESPN-style) ─────────────────────────────────────────────
function OnCourtPlayers({ onCourt, home, away }) {
  const homeAbbr  = home.abbr
  const awayAbbr  = away.abbr
  const homeColor = `#${home.color  || '1d428a'}`
  const awayColor = `#${away.color  || '222222'}`

  const homePlayers = (onCourt[homeAbbr] || []).slice(0, 5)
  const awayPlayers = (onCourt[awayAbbr] || []).slice(0, 5)

  if (!homePlayers.length && !awayPlayers.length) return null

  // Full court: 940 × 500 viewBox (NBA proportions ~94ft × 50ft scaled)
  // Baseline = left/right edges. Court runs left→right.
  const VW = 940, VH = 500

  // ── Court geometry (NBA regulation, scaled to viewBox) ──────────────────
  // Each foot ≈ 10 units wide, 10 units tall
  const BL  = 30              // left baseline x
  const BR  = VW - 30         // right baseline x
  const BT  = 25              // top boundary y
  const BB  = VH - 25         // bottom boundary y
  const CY  = VH / 2          // center y

  // Half-court helpers (left half: x=BL..mid, right half: x=mid..BR)
  const mid = VW / 2

  // Paint: 16ft wide (160u), 19ft deep (190u)
  const paintW = 160, paintH = 190
  // Left paint
  const lPaintX = BL, lPaintY = CY - paintW / 2
  // Right paint
  const rPaintX = BR - paintH, rPaintY = CY - paintW / 2

  // Basket: 63" from baseline
  const lBasketX = BL + 52, lBasketY = CY
  const rBasketX = BR - 52, rBasketY = CY
  const rimR = 18   // rim radius in units

  // FT circle radius: 6ft = 60u
  const ftR = 60
  const lFTX = BL + paintH, lFTY = CY    // center of FT circle left
  const rFTX = BR - paintH, rFTY = CY

  // 3pt line: 23.75ft arc radius = 237.5u, corners at 3ft from sideline = y±220
  const arcR = 237
  const lArcCX = lBasketX, lArcCY = CY
  const rArcCX = rBasketX, rArcCY = CY
  const cornerY1 = BT + 30, cornerY2 = BB - 30

  // Restricted area: 4ft = 40u radius
  const raR = 40

  // ── Player positions ─────────────────────────────────────────────────────
  // Home defends right basket (left side = home half)
  // Away defends left basket (right side = away half)
  // Standard offensive sets for each half

  // Left half (away team attacking left basket)
  const AWAY_POS = [
    { x: mid - 80,  y: CY },          // PG - top of key
    { x: mid - 160, y: CY - 170 },    // SG - left wing
    { x: mid - 160, y: CY + 170 },    // SF - right wing
    { x: lPaintX + paintH + 20, y: CY - 60 },  // PF - high post left
    { x: lPaintX + paintH - 40, y: CY + 60 },  // C  - low post
  ]
  // Right half (home team attacking right basket)
  const HOME_POS = [
    { x: mid + 80,  y: CY },          // PG
    { x: mid + 160, y: CY - 170 },    // SG
    { x: mid + 160, y: CY + 170 },    // SF
    { x: rPaintX - 20,  y: CY - 60 }, // PF
    { x: rPaintX + 40,  y: CY + 60 }, // C
  ]

  // ── Player node (foreignObject for headshot + text) ──────────────────────
  const ICON = 28  // icon radius in SVG units

  const PlayerNode = ({ player, x, y, color }) => {
    const lastName = (player.name || '').split(' ').pop()
    return (
      <g>
        {/* Shadow */}
        <ellipse cx={x} cy={y + ICON + 4} rx={ICON * 0.8} ry={6}
          fill="rgba(0,0,0,0.25)" />
        {/* Circle background */}
        <circle cx={x} cy={y} r={ICON + 3} fill={color} opacity="0.9" />
        {/* White ring */}
        <circle cx={x} cy={y} r={ICON + 3} fill="none" stroke="white" strokeWidth="2" opacity="0.7" />
        {/* Headshot via foreignObject */}
        <foreignObject x={x - ICON} y={y - ICON} width={ICON * 2} height={ICON * 2}
          style={{ borderRadius: '50%', overflow: 'hidden' }}>
          <div xmlns="http://www.w3.org/1999/xhtml"
            style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', background: color }}>
            {player.headshot
              ? <img src={player.headshot} alt=""
                  style={{ width: '100%', height: '130%', objectFit: 'cover', objectPosition: 'top', marginTop: '-8%' }} />
              : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'white', fontWeight: 900, fontSize: 14 }}>
                  {player.jersey}
                </div>
            }
          </div>
        </foreignObject>
        {/* Jersey badge */}
        <circle cx={x + ICON - 4} cy={y - ICON + 4} r={9} fill={color} stroke="white" strokeWidth="1.5" />
        <text x={x + ICON - 4} y={y - ICON + 8} textAnchor="middle"
          fill="white" fontSize="8" fontWeight="900">{player.jersey}</text>
        {/* Name label */}
        <rect x={x - 36} y={y + ICON + 8} width={72} height={14}
          rx="3" fill="rgba(0,0,0,0.65)" />
        <text x={x} y={y + ICON + 19} textAnchor="middle"
          fill="white" fontSize="9" fontWeight="700">{lastName}</text>
        {/* Stats pill */}
        <rect x={x - 30} y={y + ICON + 24} width={60} height={12}
          rx="3" fill="rgba(0,0,0,0.5)" />
        <text x={x} y={y + ICON + 33} textAnchor="middle"
          fill="rgba(255,255,255,0.7)" fontSize="7.5">
          {player.pts}p · {player.reb}r · {player.ast}a
        </text>
      </g>
    )
  }

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">On Court</p>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: awayColor }} />
            <span className="text-gray-400 font-bold">{awayAbbr}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: homeColor }} />
            <span className="text-gray-400 font-bold">{homeAbbr}</span>
          </span>
        </div>
      </div>

      {/* Full-court SVG */}
      <div className="rounded-xl overflow-hidden" style={{ background: '#111' }}>
        <svg viewBox={`0 0 ${VW} ${VH + 80}`} className="w-full block"
          xmlns="http://www.w3.org/2000/svg">

          {/* ── Wood floor ── */}
          <defs>
            <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#d4a855" />
              <stop offset="40%"  stopColor="#c49040" />
              <stop offset="100%" stopColor="#b07828" />
            </linearGradient>
            {/* Wood planks pattern */}
            <pattern id="planks" x="0" y="0" width="VW" height="28" patternUnits="userSpaceOnUse">
              <rect width="940" height="28" fill="none" />
              <line x1="0" y1="0" x2="940" y2="0" stroke="rgba(0,0,0,0.07)" strokeWidth="1" />
              <line x1="0" y1="14" x2="940" y2="14" stroke="rgba(0,0,0,0.04)" strokeWidth="0.5" />
            </pattern>
            <clipPath id="courtClip">
              <rect x={BL} y={BT} width={BR - BL} height={BB - BT} />
            </clipPath>
          </defs>

          {/* Floor fill */}
          <rect x={BL} y={BT} width={BR - BL} height={BB - BT} fill="url(#wood)" />
          {/* Plank lines */}
          {Array.from({ length: 17 }).map((_, i) => (
            <line key={i}
              x1={BL} y1={BT + i * ((BB - BT) / 16)}
              x2={BR} y2={BT + i * ((BB - BT) / 16)}
              stroke="rgba(0,0,0,0.06)" strokeWidth="1" />
          ))}

          {/* ── Court lines ── */}
          <g stroke="rgba(255,255,255,0.85)" strokeWidth="2.5" fill="none">
            {/* Outer boundary */}
            <rect x={BL} y={BT} width={BR - BL} height={BB - BT} />
            {/* Halfcourt line */}
            <line x1={mid} y1={BT} x2={mid} y2={BB} />
            {/* Center circle */}
            <circle cx={mid} cy={CY} r={60} />

            {/* ── LEFT HALF ── */}
            {/* Paint */}
            <rect x={BL} y={lPaintY} width={paintH} height={paintW} />
            {/* FT line */}
            <line x1={BL + paintH} y1={lPaintY} x2={BL + paintH} y2={lPaintY + paintW} strokeDasharray="none" />
            {/* FT circle top */}
            <path d={`M ${lFTX - ftR} ${lFTY} A ${ftR} ${ftR} 0 0 1 ${lFTX + ftR} ${lFTY}`} />
            {/* FT circle bottom (dashed) */}
            <path d={`M ${lFTX - ftR} ${lFTY} A ${ftR} ${ftR} 0 0 0 ${lFTX + ftR} ${lFTY}`}
              strokeDasharray="12 8" />
            {/* 3pt corners */}
            <line x1={BL} y1={cornerY1} x2={BL + 170} y2={cornerY1} />
            <line x1={BL} y1={cornerY2} x2={BL + 170} y2={cornerY2} />
            {/* 3pt arc */}
            <path d={`M ${BL + 170} ${cornerY1} A ${arcR} ${arcR} 0 0 1 ${BL + 170} ${cornerY2}`} />
            {/* Restricted area */}
            <path d={`M ${lBasketX} ${lBasketY - raR} A ${raR} ${raR} 0 0 1 ${lBasketX} ${lBasketY + raR}`} />

            {/* ── RIGHT HALF ── */}
            <rect x={rPaintX} y={rPaintY} width={paintH} height={paintW} />
            <line x1={rFTX} y1={rFTY - ftR} x2={rFTX} y2={rFTY + ftR} />
            <path d={`M ${rFTX + ftR} ${rFTY} A ${ftR} ${ftR} 0 0 1 ${rFTX - ftR} ${rFTY}`} />
            <path d={`M ${rFTX + ftR} ${rFTY} A ${ftR} ${ftR} 0 0 0 ${rFTX - ftR} ${rFTY}`}
              strokeDasharray="12 8" />
            <line x1={BR} y1={cornerY1} x2={BR - 170} y2={cornerY1} />
            <line x1={BR} y1={cornerY2} x2={BR - 170} y2={cornerY2} />
            <path d={`M ${BR - 170} ${cornerY1} A ${arcR} ${arcR} 0 0 0 ${BR - 170} ${cornerY2}`} />
            <path d={`M ${rBasketX} ${rBasketY - raR} A ${raR} ${raR} 0 0 0 ${rBasketX} ${rBasketY + raR}`} />
          </g>

          {/* ── Paint fill ── */}
          <rect x={BL} y={lPaintY} width={paintH} height={paintW}
            fill="rgba(0,0,0,0.08)" />
          <rect x={rPaintX} y={rPaintY} width={paintH} height={paintW}
            fill="rgba(0,0,0,0.08)" />

          {/* ── Baskets ── */}
          {/* Left backboard */}
          <rect x={BL + 10} y={CY - 30} width={4} height={60}
            fill="rgba(255,255,255,0.9)" rx="1" />
          {/* Left rim */}
          <circle cx={lBasketX} cy={lBasketY} r={rimR}
            fill="none" stroke="#e05020" strokeWidth="3.5" />
          {/* Right backboard */}
          <rect x={BR - 14} y={CY - 30} width={4} height={60}
            fill="rgba(255,255,255,0.9)" rx="1" />
          {/* Right rim */}
          <circle cx={rBasketX} cy={rBasketY} r={rimR}
            fill="none" stroke="#e05020" strokeWidth="3.5" />

          {/* ── Team logo areas (subtle) ── */}
          <text x={mid / 2 + BL / 2} y={CY + 6} textAnchor="middle"
            fill={awayColor} opacity="0.12" fontSize="64" fontWeight="900">{awayAbbr}</text>
          <text x={mid + (BR - mid) / 2} y={CY + 6} textAnchor="middle"
            fill={homeColor} opacity="0.12" fontSize="64" fontWeight="900">{homeAbbr}</text>

          {/* ── Players ── */}
          {awayPlayers.map((p, i) => {
            const pos = AWAY_POS[i] || AWAY_POS[4]
            return <PlayerNode key={p.id || i} player={p} x={pos.x} y={pos.y} color={awayColor} />
          })}
          {homePlayers.map((p, i) => {
            const pos = HOME_POS[i] || HOME_POS[4]
            return <PlayerNode key={p.id || i} player={p} x={pos.x} y={pos.y} color={homeColor} />
          })}

          {/* ── Scoreboard strip at bottom ── */}
          <rect x={0} y={VH} width={VW} height={80} fill="rgba(10,15,25,0.97)" />
          <line x1={0} y1={VH} x2={VW} y2={VH} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          {/* Away side */}
          <rect x={0} y={VH} width={VW / 2} height={80} fill={awayColor} opacity="0.15" />
          <rect x={VW / 2} y={VH} width={VW / 2} height={80} fill={homeColor} opacity="0.15" />
          {/* Divider */}
          <line x1={VW / 2} y1={VH + 8} x2={VW / 2} y2={VH + 72} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
          {/* Away players list */}
          {awayPlayers.map((p, i) => (
            <g key={`aw-strip-${i}`}>
              <circle cx={32 + i * 180} cy={VH + 26} r={18}
                fill={awayColor} stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" />
              {p.headshot && (
                <image href={p.headshot} x={32 + i * 180 - 18} y={VH + 26 - 18}
                  width="36" height="36" clipPath={`circle(18px at 18px 18px)`}
                  style={{ clipPath: 'circle(18px at 18px 18px)' }} />
              )}
              <text x={32 + i * 180} y={VH + 52} textAnchor="middle"
                fill="rgba(255,255,255,0.85)" fontSize="9" fontWeight="700">
                {(p.name || '').split(' ').pop()}
              </text>
              <text x={32 + i * 180} y={VH + 64} textAnchor="middle"
                fill="rgba(255,255,255,0.45)" fontSize="8">
                {p.pts}p {p.reb}r
              </text>
            </g>
          ))}
          {/* Home players list */}
          {homePlayers.map((p, i) => (
            <g key={`hm-strip-${i}`}>
              <circle cx={VW / 2 + 32 + i * 180} cy={VH + 26} r={18}
                fill={homeColor} stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" />
              {p.headshot && (
                <image href={p.headshot} x={VW / 2 + 32 + i * 180 - 18} y={VH + 26 - 18}
                  width="36" height="36"
                  style={{ clipPath: 'circle(18px at 18px 18px)' }} />
              )}
              <text x={VW / 2 + 32 + i * 180} y={VH + 52} textAnchor="middle"
                fill="rgba(255,255,255,0.85)" fontSize="9" fontWeight="700">
                {(p.name || '').split(' ').pop()}
              </text>
              <text x={VW / 2 + 32 + i * 180} y={VH + 64} textAnchor="middle"
                fill="rgba(255,255,255,0.45)" fontSize="8">
                {p.pts}p {p.reb}r
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}

// ── Shot Chart (ESPN-style wood court) ───────────────────────────────────────
function ShotChart({ shots, home, away }) {
  const [hoveredShot, setHoveredShot] = useState(null)
  const [filterTeam, setFilterTeam] = useState('all')

  if (!shots || shots.length === 0)
    return <p className="text-xs text-navy-500 text-center py-6">No shot data yet.</p>

  // Court dimensions (ft): 50 wide, 47 to halfcourt
  const CW = 500, CH = 470, PAD = 10
  const toSvg = (x, y) => ({
    sx: PAD + (x / 50) * CW,
    sy: PAD + CH - ((y + 5) / 52) * CH,
  })

  const homeColor = `#${home.color || '1d428a'}`
  const awayColor = `#${away.color || '888888'}`
  const homeAlt   = `#${home.alt_color || 'ffffff'}`
  const awayAlt   = `#${away.alt_color || 'ffffff'}`

  const visibleShots = shots.filter(s => filterTeam === 'all' || s.team_id === filterTeam)

  // Court paint fill
  const paintW = (12 / 50) * CW
  const paintH = (19 / 52) * CH
  const px = PAD + CW / 2 - paintW / 2
  const py = PAD + CH - paintH

  // FT circle
  const { sx: ftCx, sy: ftCy } = toSvg(25, 15)
  const ftR = (6 / 52) * CH

  // 3pt arc
  const arcR  = (23.75 / 52) * CH
  const c3Y   = toSvg(0, 3).sy
  const lx    = PAD + (3 / 50) * CW
  const rx    = PAD + (47 / 50) * CW

  // Basket
  const { sx: bkX, sy: bkY } = toSvg(25, 0)
  const backboardW = (6 / 50) * CW

  // Restricted area
  const { sx: raX, sy: raY } = toSvg(25, 0)
  const raR = (4 / 52) * CH

  // Quick stats
  const makeStats = (teamId) => {
    const ts = shots.filter(s => s.team_id === teamId)
    const made = ts.filter(s => s.made)
    const three = ts.filter(s => s.pts === 3)
    const madeThree = three.filter(s => s.made)
    return {
      fg: `${made.length}/${ts.length}`,
      fgPct: ts.length ? Math.round(made.length / ts.length * 100) : 0,
      threePt: `${madeThree.length}/${three.length}`,
      threePct: three.length ? Math.round(madeThree.length / three.length * 100) : 0,
    }
  }
  const homeStats = makeStats(home.id)
  const awayStats = makeStats(away.id)

  return (
    <div className="space-y-3">
      {/* Team filter buttons */}
      <div className="flex gap-2 justify-center">
        {[
          { id: 'all', label: 'All', color: '#94a3b8' },
          { id: home.id, label: home.abbr, color: homeColor },
          { id: away.id, label: away.abbr, color: awayColor },
        ].map(opt => (
          <button key={opt.id} onClick={() => setFilterTeam(opt.id)}
            className={`px-3 py-1 rounded-full text-xs font-bold border transition-all ${
              filterTeam === opt.id ? 'text-white border-transparent' : 'text-gray-400 border-gray-700 bg-transparent hover:text-gray-200'
            }`}
            style={filterTeam === opt.id ? { backgroundColor: opt.color, borderColor: opt.color } : {}}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* SVG Court */}
      <div className="overflow-x-auto rounded-xl">
        <svg viewBox={`0 0 ${CW + PAD*2} ${CH + PAD*2}`}
          className="w-full max-w-xl mx-auto block"
          style={{ background: 'linear-gradient(180deg, #c8a96e 0%, #b8955a 100%)' }}>

          {/* Wood grain lines */}
          {Array.from({ length: 16 }).map((_, i) => (
            <line key={i}
              x1={PAD} y1={PAD + (i * CH / 15)} x2={PAD + CW} y2={PAD + (i * CH / 15)}
              stroke="rgba(0,0,0,0.04)" strokeWidth="1" />
          ))}

          {/* Court boundary */}
          <rect x={PAD} y={PAD} width={CW} height={CH}
            fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="2" />

          {/* Paint / key */}
          <rect x={px} y={py} width={paintW} height={paintH}
            fill="rgba(180,140,80,0.6)" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />

          {/* Restricted area arc */}
          <path d={`M ${raX - raR} ${raY} A ${raR} ${raR} 0 0 1 ${raX + raR} ${raY}`}
            fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" />

          {/* FT circle (top half) */}
          <path d={`M ${ftCx - ftR} ${ftCy} A ${ftR} ${ftR} 0 0 1 ${ftCx + ftR} ${ftCy}`}
            fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" />
          {/* FT circle (bottom half dashed) */}
          <path d={`M ${ftCx - ftR} ${ftCy} A ${ftR} ${ftR} 0 0 0 ${ftCx + ftR} ${ftCy}`}
            fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeDasharray="6 4" />

          {/* 3-point line */}
          <g stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" fill="none">
            <line x1={lx} y1={c3Y} x2={lx} y2={PAD + CH} />
            <line x1={rx} y1={c3Y} x2={rx} y2={PAD + CH} />
            <path d={`M ${lx} ${c3Y} A ${arcR} ${arcR} 0 0 1 ${rx} ${c3Y}`} />
          </g>

          {/* Halfcourt line */}
          <line x1={PAD} y1={PAD} x2={PAD + CW} y2={PAD}
            stroke="rgba(255,255,255,0.4)" strokeWidth="1" />

          {/* Backboard */}
          <line x1={bkX - backboardW/2} y1={bkY + 10} x2={bkX + backboardW/2} y2={bkY + 10}
            stroke="rgba(255,255,255,0.8)" strokeWidth="2.5" />

          {/* Basket rim */}
          <circle cx={bkX} cy={bkY + 16} r="7"
            fill="none" stroke="rgba(255,120,50,0.9)" strokeWidth="2" />

          {/* Shot dots */}
          {visibleShots.map((s, i) => {
            const { sx, sy } = toSvg(s.x, s.y)
            const isHome = s.team_id === home.id
            const color  = isHome ? homeColor : awayColor
            const alt    = isHome ? homeAlt   : awayAlt
            const r = s.pts === 3 ? 6 : 5
            const isHovered = hoveredShot === i
            return s.made ? (
              <circle key={i} cx={sx} cy={sy} r={isHovered ? r + 2 : r}
                fill={color} stroke={alt} strokeWidth="1"
                opacity={isHovered ? 1 : 0.82}
                style={{ cursor: 'pointer', transition: 'r 0.1s' }}
                onMouseEnter={() => setHoveredShot(i)}
                onMouseLeave={() => setHoveredShot(null)}>
                <title>{s.text}</title>
              </circle>
            ) : (
              <g key={i} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredShot(i)}
                onMouseLeave={() => setHoveredShot(null)}>
                <line x1={sx - r} y1={sy - r} x2={sx + r} y2={sy + r}
                  stroke={color} strokeWidth={isHovered ? 2.5 : 1.8} opacity={isHovered ? 0.9 : 0.6} />
                <line x1={sx + r} y1={sy - r} x2={sx - r} y2={sy + r}
                  stroke={color} strokeWidth={isHovered ? 2.5 : 1.8} opacity={isHovered ? 0.9 : 0.6} />
                <title>{s.text}</title>
              </g>
            )
          })}
        </svg>
      </div>

      {/* Hover tooltip */}
      {hoveredShot !== null && visibleShots[hoveredShot] && (
        <div className="bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-xs text-gray-300 text-center mx-auto max-w-xs">
          {visibleShots[hoveredShot].text}
        </div>
      )}

      {/* Legend */}
      <div className="flex justify-center gap-6 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#888"/></svg> Made
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10">
            <line x1="1" y1="1" x2="9" y2="9" stroke="#888" strokeWidth="1.5"/>
            <line x1="9" y1="1" x2="1" y2="9" stroke="#888" strokeWidth="1.5"/>
          </svg> Missed
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#888"/></svg>
          <span className="text-navy-500">Larger = 3PT</span>
        </span>
      </div>

      {/* Shooting stats */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { t: home, s: homeStats, color: homeColor },
          { t: away, s: awayStats, color: awayColor },
        ].map(({ t, s, color }) => (
          <div key={t.abbr} className="bg-navy-800 rounded-xl p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              {t.logo && <img src={t.logo} alt={t.abbr} className="w-5 h-5 object-contain" />}
              <span className="text-sm font-bold" style={{ color }}>{t.abbr}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 text-xs">
              <div>
                <p className="text-navy-500">FG</p>
                <p className="text-gray-200 font-bold">{s.fg} <span className="text-navy-500 font-normal">({s.fgPct}%)</span></p>
              </div>
              <div>
                <p className="text-navy-500">3PT</p>
                <p className="text-gray-200 font-bold">{s.threePt} <span className="text-navy-500 font-normal">({s.threePct}%)</span></p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── ESPN-style Play Row with headshot ─────────────────────────────────────────
function EspnPlayRow({ play, homeId, homeColor, awayColor }) {
  const isHome    = play.team_id === homeId
  const teamColor = isHome ? homeColor : awayColor
  const isScoringPlay = play.is_scoring

  return (
    <div className={`flex items-start gap-3 px-4 py-2.5 border-b border-gray-100/5 hover:bg-white/3 transition-colors ${
      isScoringPlay ? 'bg-white/5' : ''
    }`}>
      {/* Player headshot or team color bar */}
      <div className="shrink-0 w-8 h-8 rounded-full overflow-hidden bg-gray-800 flex items-center justify-center">
        {play.headshot
          ? <img src={play.headshot} alt={play.athlete_name || ''} className="w-full h-full object-cover object-top" />
          : play.team_abbr
          ? <div className="w-full h-full flex items-center justify-center text-xs font-black"
              style={{ backgroundColor: teamColor, color: '#fff' }}>
              {play.team_abbr.slice(0, 2)}
            </div>
          : <div className="w-2 h-2 rounded-full bg-gray-600" />
        }
      </div>

      {/* Play content */}
      <div className="flex-1 min-w-0">
        <p className={`text-xs leading-snug ${isScoringPlay ? 'text-white font-medium' : 'text-gray-400'}`}>
          {play.text}
        </p>
        <p className="text-xs text-gray-600 mt-0.5">
          Q{play.period} · {play.clock}
        </p>
      </div>

      {/* Score */}
      <div className="text-sm tabular-nums font-bold text-gray-300 shrink-0 text-right whitespace-nowrap">
        {play.away_score} – {play.home_score}
      </div>
    </div>
  )
}

// ── Team Stat Table ───────────────────────────────────────────────────────────
function EspnStatTable({ stats, home, away }) {
  if (!stats || Object.keys(stats).length === 0)
    return <p className="text-xs text-gray-500 text-center py-4">Stats available once game starts.</p>

  const KEY_STATS = [
    ['PTS', 'Points'], ['FG', 'Field Goals'], ['FG%', 'FG%'],
    ['3PT', '3-Pointers'], ['3P%', '3P%'], ['FT', 'Free Throws'], ['FT%', 'FT%'],
    ['REB', 'Rebounds'], ['AST', 'Assists'], ['TO', 'Turnovers'],
    ['STL', 'Steals'], ['BLK', 'Blocks'],
  ]
  const teams  = [away.abbr, home.abbr].filter(t => stats[t])
  const rows   = KEY_STATS.filter(([k]) => teams.some(t => stats[t]?.[k]))

  const teamColors = { [home.abbr]: home.color, [away.abbr]: away.color }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-800">
      {/* Header */}
      <div className="grid bg-gray-900 px-4 py-2 border-b border-gray-800"
        style={{ gridTemplateColumns: '1fr auto auto' }}>
        <span className="text-xs text-gray-500">Stat</span>
        {teams.map(t => (
          <span key={t} className="text-xs font-bold w-16 text-center"
            style={{ color: `#${teamColors[t] || 'aaa'}` }}>{t}</span>
        ))}
      </div>
      {rows.map(([key, label]) => {
        const vals = teams.map(t => stats[t]?.[key] ?? '—')
        // Highlight better value
        const nums  = vals.map(v => parseFloat(v) || 0)
        const best  = Math.max(...nums)
        return (
          <div key={key} className="grid px-4 py-2 border-b border-gray-800/60 hover:bg-white/3"
            style={{ gridTemplateColumns: '1fr auto auto' }}>
            <span className="text-xs text-gray-400">{label}</span>
            {vals.map((v, i) => (
              <span key={i} className={`text-xs font-bold w-16 text-center tabular-nums ${
                parseFloat(v) === best && nums[0] !== nums[1] ? 'text-white' : 'text-gray-500'
              }`}>{v}</span>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ── Main Scoreboard Component ─────────────────────────────────────────────────
function GameScoreboard({ eventId, isLive }) {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('live')

  const { data, loading, error } = useApi(
    open ? `/api/nba/game-feed/${eventId}` : null,
    { interval: isLive ? 25000 : 0 }
  )

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="w-full text-xs text-blue-400/50 hover:text-blue-300 border border-navy-700 hover:border-navy-600 rounded-lg py-2.5 transition-colors flex items-center justify-center gap-2">
        📊 Scoreboard · Play-by-Play · Shot Chart
      </button>
    )
  }

  const home     = data?.home || {}
  const away     = data?.away || {}
  const plays    = data?.plays || []
  const winProb  = data?.win_prob
  const teamStats = data?.team_stats || {}
  const homeColor = `#${home.color || '1d428a'}`
  const awayColor = `#${away.color || '333333'}`

  return (
    <div className="rounded-xl overflow-hidden border border-gray-800" style={{ background: '#111827' }}>

      {/* ── ESPN-style Score Header ── */}
      <div className="relative overflow-hidden">
        {/* Team color strips */}
        <div className="absolute inset-0 flex">
          <div className="w-1/2 opacity-15" style={{ background: awayColor }} />
          <div className="w-1/2 opacity-15" style={{ background: homeColor }} />
        </div>

        <div className="relative px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            {/* Away team */}
            <div className="flex items-center gap-3 flex-1">
              {away.logo
                ? <img src={away.logo} alt={away.abbr} className="w-12 h-12 object-contain drop-shadow-lg" />
                : <div className="w-12 h-12 rounded-full flex items-center justify-center text-sm font-black"
                    style={{ backgroundColor: awayColor, color: '#fff' }}>{away.abbr?.slice(0,2)}</div>
              }
              <div>
                <p className="text-base font-black text-white">{away.abbr}</p>
                <p className="text-xs text-gray-500">{away.record}</p>
              </div>
            </div>

            {/* Center: score + status */}
            <div className="text-center shrink-0 px-4">
              {data?.is_live && (
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-slow" />
                  <span className="text-xs font-black text-red-400 tracking-widest">LIVE</span>
                </div>
              )}
              <div className="flex items-center gap-3">
                <span className="text-4xl font-black tabular-nums text-white">{away.score ?? 0}</span>
                <span className="text-2xl text-gray-600 font-light">–</span>
                <span className="text-4xl font-black tabular-nums text-white">{home.score ?? 0}</span>
              </div>
              <p className="text-xs text-gray-400 mt-1 font-medium">{data?.state_label || 'Scheduled'}</p>
            </div>

            {/* Home team */}
            <div className="flex items-center gap-3 flex-1 justify-end">
              <div className="text-right">
                <p className="text-base font-black text-white">{home.abbr}</p>
                <p className="text-xs text-gray-500">{home.record}</p>
              </div>
              {home.logo
                ? <img src={home.logo} alt={home.abbr} className="w-12 h-12 object-contain drop-shadow-lg" />
                : <div className="w-12 h-12 rounded-full flex items-center justify-center text-sm font-black"
                    style={{ backgroundColor: homeColor, color: '#fff' }}>{home.abbr?.slice(0,2)}</div>
              }
            </div>
          </div>

          {/* Win probability bar */}
          {winProb && (
            <div className="mt-4 space-y-1">
              <div className="flex h-2 rounded-full overflow-hidden">
                <div className="h-full transition-all duration-700"
                  style={{ width: `${winProb.away_pct}%`, backgroundColor: awayColor }} />
                <div className="h-full transition-all duration-700"
                  style={{ width: `${winProb.home_pct}%`, backgroundColor: homeColor }} />
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>{away.abbr} {winProb.away_pct}%</span>
                <span className="text-gray-600">Win Probability</span>
                <span>{winProb.home_pct}% {home.abbr}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex border-b border-gray-800 bg-gray-900/50">
        {[
          { key: 'live',  label: '🎮 Live Court' },
          { key: 'plays', label: 'Play-by-Play' },
          { key: 'shots', label: '🏀 Shot Chart' },
          { key: 'stats', label: 'Box Score' },
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2.5 text-xs font-bold tracking-wide transition-colors ${
              activeTab === tab.key
                ? 'text-white border-b-2 border-white'
                : 'text-gray-600 hover:text-gray-400'
            }`}>
            {tab.label}
          </button>
        ))}
        <button onClick={() => setOpen(false)}
          className="px-4 text-gray-700 hover:text-gray-400 text-sm">✕</button>
      </div>

      {loading && !data && <div className="p-4"><Loader /></div>}
      {error && <div className="p-3"><ErrorBox message={error} /></div>}

      {/* 🎮 Live Court Animation */}
      {activeTab === 'live' && (
        <div className="p-4" style={{ background: '#0d1117' }}>
          {data
            ? <LiveCourtAnimation eventId={eventId} isLive={isLive} home={home} away={away} />
            : <p className="text-xs text-gray-600 text-center py-8">Loading game data…</p>
          }
        </div>
      )}

      {/* Play-by-play */}
      {activeTab === 'plays' && data && (
        <div className="max-h-80 overflow-y-auto" style={{ background: '#0d1117' }}>
          {plays.length === 0
            ? <p className="text-xs text-gray-600 text-center py-8">No plays yet.</p>
            : plays.map((play, i) => (
              <EspnPlayRow key={`${play.wallclock}-${i}`} play={play}
                homeId={home.id} homeColor={home.color} awayColor={away.color} />
            ))
          }
        </div>
      )}

      {/* Shot chart + on-court players */}
      {activeTab === 'shots' && data && (
        <div className="p-4 space-y-4" style={{ background: '#0d1117' }}>
          {data.on_court && Object.keys(data.on_court).length > 0 && (
            <OnCourtPlayers onCourt={data.on_court} home={home} away={away} />
          )}
          <ShotChart shots={data.shots} home={home} away={away} />
        </div>
      )}

      {/* Box score */}
      {activeTab === 'stats' && data && (
        <div className="p-4" style={{ background: '#0d1117' }}>
          <EspnStatTable stats={teamStats} home={home} away={away} />
        </div>
      )}
    </div>
  )
}

class LiveTrackerErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    if (this.state.error) {
      return (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-center space-y-2">
          <p className="text-red-400 font-bold">Render error in Live Tracker</p>
          <pre className="text-xs text-red-300 whitespace-pre-wrap text-left bg-red-900/20 rounded p-3 max-h-48 overflow-auto">
            {this.state.error?.toString()}
            {'\n'}
            {this.state.error?.stack?.slice(0, 800)}
          </pre>
          <button onClick={() => this.setState({ error: null })}
            className="text-xs border border-red-700 text-red-300 rounded px-3 py-1 hover:bg-red-800/30">
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// Load/save watchlist from localStorage
function useWatchlist() {
  const [pinned, setPinned] = useState(() => {
    try { return JSON.parse(localStorage.getItem('player_watchlist') || '[]') }
    catch { return [] }
  })
  const save = (list) => { setPinned(list); localStorage.setItem('player_watchlist', JSON.stringify(list)) }
  const pin   = (name) => { if (!pinned.includes(name)) save([...pinned, name]) }
  const unpin = (name) => save(pinned.filter(p => p !== name))
  const toggle = (name) => pinned.includes(name) ? unpin(name) : pin(name)
  return { pinned, pin, unpin, toggle, clear: () => save([]) }
}

// Manual picks stored in localStorage — players added by name with manual lines
function useManualPicks() {
  const [picks, setPicks] = useState(() => {
    try { return JSON.parse(localStorage.getItem('manual_picks') || '[]') }
    catch { return [] }
  })
  const save = (list) => { setPicks(list); localStorage.setItem('manual_picks', JSON.stringify(list)) }
  const add    = (name) => { if (!picks.includes(name)) save([...picks, name]) }
  const remove = (name) => save(picks.filter(p => p !== name))
  return { picks, add, remove, clear: () => save([]) }
}

// A player card with no API data — all lines entered manually
function ManualPlayerCard({ playerName, onRemove }) {
  const ALL_STATS = ['PTS', 'REB', 'AST', '3PT', 'STL', 'BLK']
  const storageKey      = `bets_${playerName}`
  const linesStorageKey = `lines_${playerName}`

  const [bets, setBets] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}') } catch { return {} }
  })
  const [customLines, setCustomLines] = useState(() => {
    try { return JSON.parse(localStorage.getItem(linesStorageKey) || '{}') } catch { return {} }
  })

  const setBet = (stat, side) => {
    const next = { ...bets }
    if (side === null) { delete next[stat] } else { next[stat] = side }
    setBets(next); localStorage.setItem(storageKey, JSON.stringify(next))
  }
  const setLine = (stat, val) => {
    const next = { ...customLines }
    if (val === null) { delete next[stat] } else { next[stat] = val }
    setCustomLines(next); localStorage.setItem(linesStorageKey, JSON.stringify(next))
  }

  // Build fake props from manual lines
  const props = ALL_STATS.map(stat => ({
    stat,
    market: STAT_LABELS[stat] || stat,
    current: 0,
    line: null,
    progress: null,
    status: 'no_line',
    over_odds: null, under_odds: null,
    fanduel_over: null, fanduel_under: null,
    draftkings_over: null, draftkings_under: null,
  }))

  return (
    <div className="bg-navy-800 border border-yellow-800/40 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-gray-100">{playerName}</p>
          <p className="text-xs text-yellow-600/70">Manual pick · set lines below</p>
        </div>
        <button onClick={onRemove}
          className="text-xs text-navy-600 hover:text-red-400 transition-colors px-2 py-1 rounded border border-navy-700 hover:border-red-700">
          Remove
        </button>
      </div>
      <div className="divide-y divide-navy-700/30">
        {props.map((prop) => (
          <PropProgressRow
            key={`manual-${playerName}-${prop.stat}`}
            prop={prop}
            myBet={bets[prop.stat]}
            onSetBet={setBet}
            customLine={customLines[prop.stat] ?? null}
            onSetLine={setLine}
          />
        ))}
      </div>
    </div>
  )
}

function LiveTrackerSection() {
  const [statFilter,  setStatFilter]  = useState('all')
  const [viewMode,    setViewMode]    = useState('all')   // 'all' | 'watchlist'
  const [addInput,    setAddInput]    = useState('')
  const [manualInput, setManualInput] = useState('')
  const [suggestions, setSuggestions] = useState([])

  const { pinned, toggle, clear } = useWatchlist()
  const { picks: manualPicks, add: addManual, remove: removeManual } = useManualPicks()

  const { data, loading, error, refetch, secondsUntilRefresh } = useApi(
    '/api/props/nba/live-tracking', { interval: 30000 }
  )

  const games = data?.games ?? []

  // All player names available today (for autocomplete)
  const allPlayerNames = [...new Set(games.flatMap(g => g.players.map(p => p.player)))]

  // Autocomplete suggestions
  const handleInput = (val) => {
    setAddInput(val)
    if (val.trim().length < 2) { setSuggestions([]); return }
    const q = val.toLowerCase()
    setSuggestions(allPlayerNames.filter(n => n.toLowerCase().includes(q) && !pinned.includes(n)).slice(0, 6))
  }

  const addPlayer = (name) => {
    toggle(name)
    setAddInput('')
    setSuggestions([])
    if (pinned.length === 0) setViewMode('watchlist')
  }

  const addManualPlayer = () => {
    const name = manualInput.trim()
    if (!name) return
    addManual(name)
    setManualInput('')
  }

  const STAT_OPTS = [
    { key: 'all', label: 'All Stats' },
    { key: 'PTS', label: 'Points' },
    { key: 'REB', label: 'Rebounds' },
    { key: 'AST', label: 'Assists' },
    { key: '3PT', label: '3PM' },
    { key: 'STL', label: 'Steals' },
    { key: 'BLK', label: 'Blocks' },
  ]

  // Filter games/players based on viewMode + statFilter
  const filterGame = (g) => {
    const filtered = g.players
      .filter(p => viewMode === 'all' || pinned.includes(p.player))
      .map(p => ({
        ...p,
        props: statFilter !== 'all' ? p.props.filter(pr => pr.stat === statFilter) : p.props,
      }))
      .filter(p => p.props.length > 0)
    return { ...g, players: filtered }
  }

  // Show all games — even with 0 players (scheduled with no lines yet)
  const visibleGames = games.map(filterGame)
  const visibleLive  = visibleGames.filter(g => g.is_live)
  const visibleOther = visibleGames.filter(g => !g.is_live)

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 text-xs text-green-400/70">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse-slow inline-block" />
          Live stats from ESPN · Lines from FanDuel/DraftKings · Auto-refresh 30s
        </div>
        <div className="flex items-center gap-2">
          {secondsUntilRefresh != null && (
            <span className="text-xs text-navy-500">Refresh in {secondsUntilRefresh}s</span>
          )}
          {data?.updated_at && <span className="text-xs text-navy-500">Updated {data.updated_at}</span>}
          <button onClick={refetch} disabled={loading}
            className="text-xs border border-navy-600 text-gray-400 hover:text-gray-200 rounded-lg px-3 py-1.5 disabled:opacity-50">
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* View mode toggle */}
      <div className="flex items-center gap-2">
        <button onClick={() => setViewMode('all')}
          className={`px-4 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
            viewMode === 'all'
              ? 'bg-navy-600 border-navy-500 text-gray-100'
              : 'bg-navy-800 border-navy-700 text-gray-500 hover:text-gray-300'
          }`}>
          All Players
        </button>
        <button onClick={() => setViewMode('watchlist')}
          className={`px-4 py-1.5 rounded-lg text-xs font-semibold border transition-colors flex items-center gap-1.5 ${
            viewMode === 'watchlist'
              ? 'bg-yellow-700/60 border-yellow-600 text-yellow-200'
              : 'bg-navy-800 border-navy-700 text-gray-500 hover:text-gray-300'
          }`}>
          ⭐ My Players
          {pinned.length > 0 && (
            <span className={`text-xs rounded-full px-1.5 py-0.5 font-bold ${
              viewMode === 'watchlist' ? 'bg-yellow-600/50 text-yellow-200' : 'bg-navy-700 text-gray-400'
            }`}>{pinned.length}</span>
          )}
        </button>
      </div>

      {/* Watchlist management */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            ⭐ My Players Watchlist
          </p>
          {pinned.length > 0 && (
            <button onClick={clear} className="text-xs text-red-500/70 hover:text-red-400 transition-colors">
              Clear all
            </button>
          )}
        </div>

        {/* Pinned player chips */}
        {pinned.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {pinned.map(name => (
              <div key={name}
                className="flex items-center gap-1.5 bg-yellow-900/30 border border-yellow-700/50 rounded-lg pl-3 pr-1.5 py-1">
                <span className="text-xs font-semibold text-yellow-200">{name}</span>
                <button onClick={() => toggle(name)}
                  className="text-yellow-600 hover:text-red-400 transition-colors text-xs font-bold w-4 h-4 flex items-center justify-center">
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-navy-500">No players added yet. Search below to add players from today's games.</p>
        )}

        {/* Add player input with autocomplete */}
        <div className="relative">
          <div className="flex gap-2">
            <input
              type="text"
              value={addInput}
              onChange={e => handleInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && suggestions.length > 0) addPlayer(suggestions[0])
                if (e.key === 'Escape') { setAddInput(''); setSuggestions([]) }
              }}
              placeholder="Type player name to add… (e.g. LeBron James)"
              className="flex-1 bg-navy-700 border border-navy-600 focus:border-yellow-600 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors"
            />
            {addInput && (
              <button onClick={() => { setAddInput(''); setSuggestions([]) }}
                className="text-xs text-gray-500 hover:text-gray-300 border border-navy-600 rounded-lg px-3">
                ✕
              </button>
            )}
          </div>

          {/* Autocomplete dropdown */}
          {suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-navy-700 border border-navy-600 rounded-xl shadow-xl z-20 overflow-hidden">
              {suggestions.map(name => (
                <button key={name} onClick={() => addPlayer(name)}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-navy-600 transition-colors flex items-center justify-between">
                  <span>{name}</span>
                  <span className="text-xs text-yellow-500">+ Add</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Manual picks panel */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            ✏️ Manual Picks — any player, any line
          </p>
          {manualPicks.length > 0 && (
            <button onClick={() => { manualPicks.forEach(n => removeManual(n)) }}
              className="text-xs text-red-500/70 hover:text-red-400">Clear all</button>
          )}
        </div>
        <p className="text-xs text-navy-500">
          Add any player by name — even if they have no posted odds. Set your own lines manually.
        </p>

        {/* Manual pick chips */}
        {manualPicks.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {manualPicks.map(name => (
              <div key={name} className="flex items-center gap-1.5 bg-navy-700 border border-navy-600 rounded-lg pl-3 pr-1.5 py-1">
                <span className="text-xs font-semibold text-gray-300">{name}</span>
                <button onClick={() => removeManual(name)}
                  className="text-navy-500 hover:text-red-400 text-xs font-bold w-4 h-4 flex items-center justify-center">✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Manual add input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={manualInput}
            onChange={e => setManualInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addManualPlayer() }}
            placeholder="Type any player name… (e.g. LeBron James)"
            className="flex-1 bg-navy-700 border border-navy-600 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 outline-none transition-colors"
          />
          <button onClick={addManualPlayer}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2 font-semibold transition-colors">
            Add
          </button>
        </div>
      </div>

      {/* Manual player cards */}
      {manualPicks.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-semibold text-blue-400/70 uppercase tracking-wider">✏️ My Manual Picks</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {manualPicks.map(name => (
              <ManualPlayerCard key={name} playerName={name} onRemove={() => removeManual(name)} />
            ))}
          </div>
        </div>
      )}

      {/* Stat filter */}
      <div className="flex flex-wrap gap-2">
        {STAT_OPTS.map(({ key, label }) => (
          <button key={key} onClick={() => setStatFilter(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              statFilter === key
                ? 'bg-brand-600 border-brand-500 text-white'
                : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {loading && !data && <Loader />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && visibleGames.length === 0 && (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-10 text-center">
          <p className="text-4xl mb-3">{viewMode === 'watchlist' ? '⭐' : '🏀'}</p>
          <p className="text-gray-400 text-sm">
            {viewMode === 'watchlist'
              ? pinned.length === 0
                ? 'Add players to your watchlist above to track them here.'
                : 'None of your watchlist players are in today\'s games.'
              : 'No NBA games today with available data.'
            }
          </p>
        </div>
      )}

      {/* Live games */}
      {visibleLive.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-semibold text-green-400 uppercase tracking-wider flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse-slow" />
            Live Now
          </h2>
          {visibleLive.map(g => (
            <GameTrackerCard key={g.event_id} game={g} statFilter="all" searchQ=""
              pinnedPlayers={pinned} onTogglePin={toggle} />
          ))}
        </div>
      )}

      {/* Other games */}
      {visibleOther.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-semibold text-navy-500 uppercase tracking-wider">
            {visibleLive.length > 0 ? "Today's Other Games" : "Today's Games"}
          </h2>
          {visibleOther.map(g => (
            <GameTrackerCard key={g.event_id} game={g} statFilter="all" searchQ=""
              pinnedPlayers={pinned} onTogglePin={toggle} />
          ))}
        </div>
      )}

      <p className="text-xs text-navy-600 text-center pb-2">
        Progress bar = current stat / prop line · Green = hit · Yellow = 75%+ · Lines from FanDuel/DraftKings
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Props page
// ---------------------------------------------------------------------------
export default function Props() {
  const [tab, setTab] = useState('predictions')
  const [soccerLeague, setSoccerLeague] = useState('soccer_uefa_champs_league')

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Player Props & Alt Markets</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          AI prop predictions · NBA lines · Soccer alt markets
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setTab('live')}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            tab === 'live'
              ? 'bg-green-700 border-green-600 text-white'
              : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
          }`}
        >
          <span className="inline-flex items-center gap-1.5">
            {tab === 'live' && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse-slow" />}
            📊 Live Tracker
          </span>
        </button>
        <button
          onClick={() => setTab('predictions')}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            tab === 'predictions'
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
          }`}
        >
          🤖 AI Prop Predictions
        </button>
        <button
          onClick={() => setTab('nba')}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            tab === 'nba'
              ? 'bg-brand-600 border-brand-500 text-white'
              : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
          }`}
        >
          🏀 NBA Player Props
        </button>
        <button
          onClick={() => setTab('soccer')}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            tab === 'soccer'
              ? 'bg-brand-600 border-brand-500 text-white'
              : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
          }`}
        >
          ⚽ Soccer Alt Markets
        </button>
      </div>

      {/* Live Tracker Tab */}
      {tab === 'live' && (
        <LiveTrackerErrorBoundary>
          <LiveTrackerSection />
        </LiveTrackerErrorBoundary>
      )}

      {/* AI Predictions Tab */}
      {tab === 'predictions' && <AIPredictionsSection />}

      {/* NBA Tab */}
      {tab === 'nba' && <NbaSection />}

      {/* Soccer Tab */}
      {tab === 'soccer' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {SOCCER_SPORT_KEYS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSoccerLeague(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  soccerLeague === key
                    ? 'bg-brand-600 border-brand-500 text-white'
                    : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <SoccerSection key={soccerLeague} sportKey={soccerLeague} />
        </div>
      )}

      <p className="text-xs text-gray-600 text-center pb-2">
        Odds from The Odds API (EU/UK bookmakers for soccer, US bookmakers for NBA). Bet responsibly. 18+.
      </p>
    </div>
  )
}
