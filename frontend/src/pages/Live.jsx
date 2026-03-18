import { useState, useEffect, useRef } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'

// ── helpers ───────────────────────────────────────────────────────────────────

function sportIcon(sport) {
  if (!sport) return '🏟️'
  const s = sport.toLowerCase()
  if (s === 'soccer')     return '⚽'
  if (s === 'basketball') return '🏀'
  if (s === 'baseball')   return '⚾'
  return '🏟️'
}

function isLiveGame(g) {
  const s = (g.status || '').toLowerCase()
  return s.includes('progress') || s === 'in_progress' || s === 'live' || s.includes('inprogress')
}

function isFinishedGame(g) {
  const s = (g.status || '').toLowerCase()
  return s.includes('final') || s === 'ft' || s.includes('full_time') || s.includes('full time')
}

const LEAGUE_SLUGS = ['epl', 'bundesliga', 'laliga', 'liga_mx', 'ucl', 'europa', 'nba', 'mlb']

// ── Score display with bump animation when score changes ──────────────────────

function AnimatedScore({ value }) {
  const [bump, setBump] = useState(false)
  const prev = useRef(value)

  useEffect(() => {
    if (prev.current !== value) {
      setBump(true)
      const t = setTimeout(() => setBump(false), 450)
      prev.current = value
      return () => clearTimeout(t)
    }
  }, [value])

  return (
    <span className={bump ? 'animate-score-bump inline-block' : 'inline-block'}>
      {value ?? 0}
    </span>
  )
}

// ── Live dot indicator ────────────────────────────────────────────────────────

function LiveDot() {
  return (
    <span className="relative inline-flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse-slow" />
      <span className="text-xs font-bold text-green-400 uppercase tracking-wider">Live</span>
    </span>
  )
}

// ── ScoreCard ─────────────────────────────────────────────────────────────────

function ScoreCard({ game }) {
  const isFinal = isFinishedGame(game)
  const isLive  = isLiveGame(game)

  return (
    <div className={`bg-navy-800 border rounded-xl p-4 space-y-3 transition-all ${
      isLive ? 'border-green-700/60 shadow-[0_0_12px_rgba(74,222,128,0.08)]' : 'border-navy-700'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-blue-400/70 uppercase tracking-wide font-medium">
          {sportIcon(game.sport)} {game.league}
          {game.venue && <span className="text-navy-500 ml-2">· {game.venue}</span>}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {game.date && (
            <span className="text-xs text-navy-500">
              {new Date(game.date).toLocaleString([], {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })}
            </span>
          )}
          {isLive && <LiveDot />}
          {isFinal && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-navy-700 text-gray-400">
              Final
            </span>
          )}
          {!isLive && !isFinal && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-navy-700 text-blue-400">
              Scheduled
            </span>
          )}
        </div>
      </div>

      {/* Score row */}
      <div className="grid grid-cols-3 items-center text-center gap-2">
        {/* Home */}
        <div>
          <p className="text-sm font-semibold text-gray-100 leading-tight">{game.home_team}</p>
          {game.home_form_str && (
            <p className="text-xs text-navy-500 mt-0.5">{game.home_form_str}</p>
          )}
        </div>

        {/* Score / VS */}
        <div className="text-2xl font-bold tabular-nums">
          {isFinal || isLive ? (
            <span className={isLive ? 'text-green-300' : 'text-gray-100'}>
              <AnimatedScore value={game.home_score} />
              <span className="text-navy-600 mx-1">–</span>
              <AnimatedScore value={game.away_score} />
            </span>
          ) : (
            <span className="text-navy-600 text-lg">vs</span>
          )}
        </div>

        {/* Away */}
        <div>
          <p className="text-sm font-semibold text-gray-100 leading-tight">{game.away_team}</p>
          {game.away_form_str && (
            <p className="text-xs text-navy-500 mt-0.5">{game.away_form_str}</p>
          )}
        </div>
      </div>

      {/* Live game period / clock */}
      {isLive && game.period && (
        <div className="text-center text-xs text-green-400/80">
          {game.period}{game.clock ? ` · ${game.clock}` : ''}
        </div>
      )}

      {/* Stat pills */}
      {(game.home_possession != null || game.home_shots_on_target != null || game.home_rebounds != null || game.home_hits != null) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-navy-500 justify-center">
          {game.home_possession != null && (
            <span>
              Poss:&nbsp;
              <b className="text-gray-300">{game.home_possession}%</b>
              <span className="text-navy-600 mx-1">–</span>
              <b className="text-gray-300">{game.away_possession}%</b>
            </span>
          )}
          {game.home_shots != null && (
            <span>
              Shots:&nbsp;
              <b className="text-gray-300">{game.home_shots}</b>
              <span className="text-navy-600 mx-1">–</span>
              <b className="text-gray-300">{game.away_shots}</b>
            </span>
          )}
          {game.home_shots_on_target != null && (
            <span>
              SoT:&nbsp;
              <b className="text-gray-300">{game.home_shots_on_target}</b>
              <span className="text-navy-600 mx-1">–</span>
              <b className="text-gray-300">{game.away_shots_on_target}</b>
            </span>
          )}
          {game.home_rebounds != null && (
            <span>
              Reb:&nbsp;
              <b className="text-gray-300">{game.home_rebounds}</b>
              <span className="text-navy-600 mx-1">–</span>
              <b className="text-gray-300">{game.away_rebounds}</b>
            </span>
          )}
          {game.home_hits != null && (
            <span>
              Hits:&nbsp;
              <b className="text-gray-300">{game.home_hits}</b>
              <span className="text-navy-600 mx-1">–</span>
              <b className="text-gray-300">{game.away_hits}</b>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Scoreboard ────────────────────────────────────────────────────────────────

function ScoreboardTab() {
  const [league, setLeague] = useState('all')
  const [search, setSearch] = useState('')

  const endpoint = league === 'all' ? '/api/scoreboard' : `/api/scoreboard/${league}`
  const { data, loading, error, refetch, secondsUntilRefresh } = useApi(endpoint, { interval: 30000 })

  const allGames = (data?.games ?? []).filter(g => {
    const q = search.toLowerCase()
    return !q || g.home_team?.toLowerCase().includes(q) || g.away_team?.toLowerCase().includes(q)
  })

  const liveGames      = allGames.filter(g => isLiveGame(g))
  const scheduledGames = allGames.filter(g => !isLiveGame(g) && !isFinishedGame(g))
  const finishedGames  = allGames.filter(g => isFinishedGame(g))

  return (
    <div className="space-y-6">
      {/* Controls bar */}
      <div className="flex flex-wrap gap-3 items-center">
        <select
          value={league}
          onChange={e => setLeague(e.target.value)}
          className="bg-navy-800 border border-navy-700 rounded-lg text-sm text-gray-300 px-3 py-2 focus:outline-none focus:border-blue-500"
        >
          <option value="all">All Leagues</option>
          {LEAGUE_SLUGS.map(s => (
            <option key={s} value={s}>{s.toUpperCase().replace('_', ' ')}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search team..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-navy-800 border border-navy-700 rounded-lg text-sm text-gray-300 px-4 py-2 focus:outline-none focus:border-blue-500 w-48"
        />
        <div className="ml-auto flex items-center gap-3">
          {secondsUntilRefresh != null && (
            <span className="text-xs text-navy-500">
              Refresh in {secondsUntilRefresh}s
            </span>
          )}
          <button
            onClick={refetch}
            className="text-xs text-gray-400 hover:text-gray-200 border border-navy-700 hover:border-navy-600 rounded-lg px-3 py-2 transition-colors"
          >
            Refresh now
          </button>
        </div>
      </div>

      {loading && <Loader />}
      {error   && <ErrorBox message={error} />}

      {!loading && !error && allGames.length === 0 && (
        <div className="text-center py-16 text-navy-500">
          <p className="text-5xl mb-4">📭</p>
          <p className="text-gray-400">No games found for today.</p>
          <p className="text-sm mt-1">Try a different league or check back later.</p>
        </div>
      )}

      {/* ── Live Now ── */}
      {!loading && (
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <LiveDot />
            <h2 className="section-header">Live Now</h2>
            {liveGames.length > 0 && (
              <span className="text-xs text-green-700 font-medium">
                {liveGames.length} game{liveGames.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {liveGames.length === 0 ? (
            <div className="bg-navy-800 border border-navy-700 rounded-xl px-4 py-6 text-center text-navy-500 text-sm">
              No live games right now — check the schedule below for upcoming kick-offs.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-fade-in">
              {liveGames.map((g, i) => (
                <ScoreCard key={`live-${g.home_team}-${g.away_team}-${i}`} game={g} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Today's Schedule ── */}
      {!loading && scheduledGames.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="section-header">Today's Schedule</h2>
            <span className="text-xs text-navy-500 font-normal">{scheduledGames.length} upcoming</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {scheduledGames.map((g, i) => (
              <ScoreCard key={`sched-${g.home_team}-${g.away_team}-${i}`} game={g} />
            ))}
          </div>
        </section>
      )}

      {/* ── Final Results (collapsible) ── */}
      {!loading && finishedGames.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer select-none list-none flex items-center gap-2 text-sm font-semibold text-navy-500 hover:text-gray-400 uppercase tracking-wider transition-colors">
            <span className="group-open:hidden">▶</span>
            <span className="hidden group-open:inline">▼</span>
            Final Results
            <span className="text-xs font-normal normal-case text-navy-600 ml-1">
              {finishedGames.length} finished
            </span>
          </summary>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-3 opacity-60">
            {finishedGames.map((g, i) => (
              <ScoreCard key={`final-${g.home_team}-${g.away_team}-${i}`} game={g} />
            ))}
          </div>
        </details>
      )}

      <p className="text-xs text-navy-600 text-center pb-2">
        Scoreboard data via ESPN · Auto-refreshes every 30s
      </p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Live() {
  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Live Scores</h1>
          <p className="text-sm text-navy-500 mt-0.5">Real-time scoreboards — no live odds</p>
        </div>
      </div>

      <ScoreboardTab />
    </div>
  )
}
