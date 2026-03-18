import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'

const API_BASE = import.meta.env.VITE_API_BASE || ''

const TIER_STYLES = {
  Strong:   'bg-green-900/60 text-green-300 border border-green-700',
  Moderate: 'bg-yellow-900/50 text-yellow-300 border border-yellow-700',
  Lean:     'bg-navy-700 text-gray-400 border border-navy-600',
}
const SPORT_ICON = { soccer: '⚽', nba: '🏀', mlb: '⚾' }

function pct(val) { return val == null ? '—' : (Number(val) * 100).toFixed(1) + '%' }
function fmt(n, d = 2) { return n == null ? '—' : Number(n).toFixed(d) }

// ---------------------------------------------------------------------------
// Kelly Stake Calculator
// ---------------------------------------------------------------------------
function KellyCalc({ pick }) {
  const [bankroll, setBankroll] = useState('')
  const [fraction, setFraction] = useState(0.25)

  const b = (pick.odds ?? 0) - 1
  const p = pick.model_prob != null ? pick.model_prob : 0.5
  const q = 1 - p
  const kelly = b > 0 ? Math.max(0, (b * p - q) / b) : 0
  const fractional = kelly * fraction
  const stake = bankroll ? (parseFloat(bankroll) * fractional).toFixed(2) : null
  const ret = stake && pick.odds ? (parseFloat(stake) * pick.odds).toFixed(2) : null

  return (
    <div className="mt-3 bg-navy-700/60 rounded-lg p-3 space-y-2">
      <p className="text-xs font-semibold text-gray-400">Kelly Stake Calculator</p>
      <div className="flex flex-wrap gap-2 items-center">
        <div>
          <label className="text-xs text-gray-500">Bankroll ($)</label>
          <input
            type="number" value={bankroll} onChange={e => setBankroll(e.target.value)}
            placeholder="10000"
            className="mt-0.5 block w-28 bg-navy-600 border border-navy-500 rounded px-2 py-1 text-sm text-gray-100"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500">Kelly fraction</label>
          <select value={fraction} onChange={e => setFraction(Number(e.target.value))}
            className="mt-0.5 block bg-navy-600 border border-navy-500 rounded px-2 py-1 text-sm text-gray-100">
            <option value={0.25}>¼ Kelly</option>
            <option value={0.5}>½ Kelly</option>
            <option value={1}>Full Kelly</option>
          </select>
        </div>
      </div>
      <div className="text-xs text-gray-400 space-y-0.5">
        <p>Full Kelly: <span className="text-gray-200 font-medium">{pct(kelly)}</span> of bankroll</p>
        <p>At {fraction === 0.25 ? '¼' : fraction === 0.5 ? '½' : 'full'} Kelly: <span className="text-gray-200 font-medium">{pct(fractional)}</span> of bankroll</p>
        {stake && <p className="text-green-400 font-semibold">Stake: ${stake} → potential return: ${ret}</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// H2H History
// ---------------------------------------------------------------------------
function H2HPanel({ homeTeam, awayTeam }) {
  const [open, setOpen] = useState(false)
  const enc = t => encodeURIComponent(t)
  const { data, loading, error } = useApi(
    open ? `/api/h2h?home=${enc(homeTeam)}&away=${enc(awayTeam)}&n=8` : null
  )
  const matches = data?.matches ?? []

  return (
    <div className="mt-2">
      <button onClick={() => setOpen(o => !o)}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
        {open ? '▲ Hide H2H history' : '▼ Head-to-Head history'}
      </button>
      {open && (
        <div className="mt-2">
          {loading && <p className="text-xs text-gray-500">Loading…</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
          {!loading && matches.length === 0 && (
            <p className="text-xs text-gray-600">No H2H data found in historical records.</p>
          )}
          {matches.length > 0 && (
            <table className="w-full text-xs mt-1">
              <thead>
                <tr className="text-gray-600 border-b border-navy-700">
                  <th className="pb-1 text-left">Date</th>
                  <th className="pb-1 text-left">Home</th>
                  <th className="pb-1 text-center">Score</th>
                  <th className="pb-1 text-left">Away</th>
                  <th className="pb-1 text-center">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-700/40">
                {matches.map((m, i) => (
                  <tr key={i}>
                    <td className="py-1 text-gray-600">{m.date?.slice(0, 10)}</td>
                    <td className="py-1 text-gray-400">{m.home_team}</td>
                    <td className="py-1 text-center font-mono text-gray-200">
                      {m.home_score ?? '?'} – {m.away_score ?? '?'}
                    </td>
                    <td className="py-1 text-gray-400">{m.away_team}</td>
                    <td className="py-1 text-center">
                      <span className={`font-bold ${m.result === 'W' ? 'text-green-400' : m.result === 'L' ? 'text-red-400' : 'text-gray-500'}`}>
                        {m.result}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// News Sentiment Panel
// ---------------------------------------------------------------------------
function NewsPanel({ team }) {
  const [open, setOpen] = useState(false)
  const { data, loading } = useApi(open ? `/api/news/${encodeURIComponent(team)}` : null)
  const articles = data?.articles ?? []

  return (
    <div className="mt-1">
      <button onClick={() => setOpen(o => !o)}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
        {open ? '▲ Hide news' : '▼ Latest news & sentiment'}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {loading && <p className="text-xs text-gray-500">Loading…</p>}
          {!loading && articles.length === 0 && (
            <p className="text-xs text-gray-600">No recent news found.</p>
          )}
          {articles.map((a, i) => (
            <div key={i} className="bg-navy-700/40 rounded p-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-gray-300 leading-snug flex-1">{a.title}</p>
                <span className={`text-xs font-bold shrink-0 ${
                  a.sentiment_label === 'positive' ? 'text-green-400' :
                  a.sentiment_label === 'negative' ? 'text-red-400' : 'text-gray-500'
                }`}>
                  {a.sentiment_label === 'positive' ? '▲' : a.sentiment_label === 'negative' ? '▼' : '•'}
                </span>
              </div>
              <p className="text-xs text-gray-600 mt-0.5">{a.source} · {a.publishedAt?.slice(0, 10)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pick Card
// ---------------------------------------------------------------------------
function PickCard({ pick, narrative, showKelly = true }) {
  const [showKellyCalc, setShowKellyCalc] = useState(false)
  const [showNarrative, setShowNarrative] = useState(false)
  const tierStyle = TIER_STYLES[pick.tier] || TIER_STYLES.Lean
  const isTotals = pick.market === 'totals'
  const isDraw   = pick.market === 'draw'
  const winProb = pick.win_probability ?? pick.model_prob
  const showOdds = false

  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-5 space-y-3 hover:border-navy-500 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-lg">{SPORT_ICON[pick.sport] || '🎯'}</span>
          <span className="text-xs text-gray-500 uppercase tracking-wider">{pick.league}</span>
          {isTotals && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 border border-blue-700">
              O/U Total
            </span>
          )}
          {isDraw && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-900/60 text-purple-300 border border-purple-700">
              Draw
            </span>
          )}
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${tierStyle}`}>{pick.tier}</span>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-green-400">{pct(winProb)} win</div>
          <div className="text-xs text-gray-500">AI recommends: <span className="text-gray-200 font-semibold">{pick.bet_team}</span></div>
        </div>
      </div>

      {/* Matchup / Bet label */}
      {isTotals ? (
        <div className="text-center py-1 space-y-1">
          <div className="text-lg font-bold text-white">
            {pick.bet_side === 'over' ? 'Over' : 'Under'}{' '}
            <span className="text-brand-400">{pick.total_line}</span>
          </div>
          <div className="text-xs text-gray-500">{pick.home_team} vs {pick.away_team}</div>
          <div className="text-xs text-gray-600">
            Model expects: <span className="text-gray-300">{pick.expected_total}</span>
            {' · '}Line: <span className="text-gray-300">{pick.total_line}</span>
            {' · '}Deviation: <span className={pick.deviation > 0 ? 'text-green-400' : 'text-red-400'}>
              {pick.deviation > 0 ? '+' : ''}{pick.deviation}
            </span>
          </div>
          {pick.venue && <div className="text-xs text-gray-700">{pick.venue}</div>}
        </div>
      ) : isDraw ? (
        <div className="text-center py-1 space-y-1">
          <div className="text-lg font-bold text-purple-300">Draw</div>
          <div className="text-sm text-gray-300 font-medium">{pick.home_team} vs {pick.away_team}</div>
          <div className="text-xs text-gray-600">
            3-way odds — Home: <span className="text-gray-400">{pick.home_odds?.toFixed(2) ?? '—'}</span>
            {' · '}Draw: <span className="text-purple-400 font-semibold">{pick.draw_odds?.toFixed(2) ?? '—'}</span>
            {' · '}Away: <span className="text-gray-400">{pick.away_odds?.toFixed(2) ?? '—'}</span>
          </div>
          {pick.venue && <div className="text-xs text-gray-700">{pick.venue}</div>}
        </div>
      ) : (
        <div className="text-center py-1">
          <div className="flex items-center justify-center gap-3">
            <span className={`text-base font-semibold ${pick.bet_side === 'home' ? 'text-white' : 'text-gray-400'}`}>
              {pick.home_team}
              {pick.bet_side === 'home' && <span className="ml-1.5 text-xs text-green-400">← BET</span>}
            </span>
            <span className="text-gray-600 text-sm">vs</span>
            <span className={`text-base font-semibold ${pick.bet_side === 'away' ? 'text-white' : 'text-gray-400'}`}>
              {pick.away_team}
              {pick.bet_side === 'away' && <span className="ml-1.5 text-xs text-green-400">BET →</span>}
            </span>
          </div>
          {pick.venue && <div className="text-xs text-gray-600 mt-0.5">{pick.venue}</div>}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-navy-700/50 rounded-lg p-2">
          <div className="text-xs text-gray-500">Home win</div>
          <div className="text-sm font-bold text-gray-100">{pct(pick.model_prob_home)}</div>
        </div>
        <div className="bg-navy-700/50 rounded-lg p-2">
          <div className="text-xs text-gray-500">Away win</div>
          <div className="text-sm font-bold text-gray-400">{pct(pick.model_prob_away)}</div>
        </div>
        <div className="bg-navy-700/50 rounded-lg p-2">
          <div className="text-xs text-gray-500">Confidence</div>
          <div className="text-sm font-bold text-gray-100">{pct((pick.confidence ?? Math.abs((pick.model_prob_home ?? 0.5) - (pick.model_prob_away ?? 0.5))))}</div>
        </div>
      </div>

      {/* Form bar — visual edge indicator */}
      {!isTotals && !isDraw && pick.home_form != null && pick.away_form != null && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-600">
            <span>Avg scored last 5: <span className="text-gray-400">{pick.bet_side === 'home' ? pick.home_form : pick.away_form}</span></span>
            <span>Opp allowed: <span className="text-gray-400">{pick.bet_side === 'home' ? pick.away_form : pick.home_form}</span></span>
          </div>
          <div className="h-1.5 bg-navy-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, ((winProb || 0.5) * 100))}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-700">
            <span>50%</span>
            <span className="text-brand-600">{pct(winProb)} AI win</span>
            <span>100%</span>
          </div>
        </div>
      )}

      {/* Bookmaker Odds */}
      {showOdds && (isDraw ? (
        pick.odds_source === 'the_odds_api' ? (
          <div className="bg-navy-700/40 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400">3-Way Odds</span>
              <span className="text-xs text-green-500 font-medium">The Odds API</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="flex flex-col items-center bg-navy-800/60 rounded px-2 py-2">
                <span className="text-gray-500 mb-1">Home</span>
                <span className="text-gray-300 font-semibold">{pick.home_odds?.toFixed(2) ?? '—'}</span>
              </div>
              <div className="flex flex-col items-center bg-navy-800/60 rounded px-2 py-2 ring-1 ring-purple-600">
                <span className="text-gray-500 mb-1">Draw</span>
                <span className="text-purple-400 font-bold">{pick.draw_odds?.toFixed(2) ?? '—'}</span>
                <span className="text-purple-500 text-xs mt-0.5">← BET</span>
              </div>
              <div className="flex flex-col items-center bg-navy-800/60 rounded px-2 py-2">
                <span className="text-gray-500 mb-1">Away</span>
                <span className="text-gray-300 font-semibold">{pick.away_odds?.toFixed(2) ?? '—'}</span>
              </div>
            </div>
            {(pick.draw_fanduel != null || pick.draw_draftkings != null) && (
              <div className="grid grid-cols-2 gap-2 text-xs mt-1">
                {pick.draw_fanduel != null && (
                  <div className="flex items-center justify-between bg-navy-800/60 rounded px-2 py-1.5">
                    <span className="text-gray-500">FD Draw</span>
                    <span className="text-purple-300 font-semibold">{pick.draw_fanduel.toFixed(2)}</span>
                  </div>
                )}
                {pick.draw_draftkings != null && (
                  <div className="flex items-center justify-between bg-navy-800/60 rounded px-2 py-1.5">
                    <span className="text-gray-500">DK Draw</span>
                    <span className="text-purple-300 font-semibold">{pick.draw_draftkings.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="bg-yellow-900/20 border border-yellow-900/40 rounded-lg px-3 py-2 flex items-center gap-2">
            <span className="text-yellow-600 text-xs">⚠</span>
            <span className="text-xs text-yellow-700">Simulated odds — no live draw market data for this game</span>
          </div>
        )
      ) : isTotals ? (
        pick.odds_source === 'the_odds_api' ? (
          <div className="bg-navy-700/40 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400">Over / Under Odds</span>
              <span className="text-xs text-green-500 font-medium">The Odds API</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className={`flex flex-col items-center bg-navy-800/60 rounded px-3 py-2 ${pick.bet_side === 'over' ? 'ring-1 ring-green-600' : ''}`}>
                <span className="text-gray-500 mb-1">Over {pick.total_line}</span>
                <span className={`font-bold text-sm ${pick.bet_side === 'over' ? 'text-green-400' : 'text-gray-300'}`}>
                  {pick.over_odds != null ? pick.over_odds.toFixed(2) : '—'}
                </span>
                {pick.bet_side === 'over' && <span className="text-green-500 text-xs mt-0.5">← BET</span>}
              </div>
              <div className={`flex flex-col items-center bg-navy-800/60 rounded px-3 py-2 ${pick.bet_side === 'under' ? 'ring-1 ring-green-600' : ''}`}>
                <span className="text-gray-500 mb-1">Under {pick.total_line}</span>
                <span className={`font-bold text-sm ${pick.bet_side === 'under' ? 'text-green-400' : 'text-gray-300'}`}>
                  {pick.under_odds != null ? pick.under_odds.toFixed(2) : '—'}
                </span>
                {pick.bet_side === 'under' && <span className="text-green-500 text-xs mt-0.5">← BET</span>}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-yellow-900/20 border border-yellow-900/40 rounded-lg px-3 py-2 flex items-center gap-2">
            <span className="text-yellow-600 text-xs">⚠</span>
            <span className="text-xs text-yellow-700">Simulated odds — no live market data for this game</span>
          </div>
        )
      ) : (
        pick.odds_source === 'the_odds_api' ? (
          <div className="bg-navy-700/40 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400">Live Odds</span>
              <span className="text-xs text-green-500 font-medium">The Odds API</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {/* FanDuel row */}
              <div className="flex items-center justify-between bg-navy-800/60 rounded px-2 py-1.5">
                <span className="text-gray-500 font-medium">FD</span>
                <div className="flex gap-3">
                  <span>
                    <span className={pick.bet_side === 'home' ? 'text-green-400 font-bold' : 'text-gray-400'}>
                      {pick.home_fanduel != null ? pick.home_fanduel.toFixed(2) : '—'}
                    </span>
                    <span className="text-gray-700 mx-1">/</span>
                    <span className={pick.bet_side === 'away' ? 'text-green-400 font-bold' : 'text-gray-400'}>
                      {pick.away_fanduel != null ? pick.away_fanduel.toFixed(2) : '—'}
                    </span>
                  </span>
                </div>
              </div>
              {/* DraftKings row */}
              <div className="flex items-center justify-between bg-navy-800/60 rounded px-2 py-1.5">
                <span className="text-gray-500 font-medium">DK</span>
                <div className="flex gap-3">
                  <span>
                    <span className={pick.bet_side === 'home' ? 'text-green-400 font-bold' : 'text-gray-400'}>
                      {pick.home_draftkings != null ? pick.home_draftkings.toFixed(2) : '—'}
                    </span>
                    <span className="text-gray-700 mx-1">/</span>
                    <span className={pick.bet_side === 'away' ? 'text-green-400 font-bold' : 'text-gray-400'}>
                      {pick.away_draftkings != null ? pick.away_draftkings.toFixed(2) : '—'}
                    </span>
                  </span>
                </div>
              </div>
            </div>
            <p className="text-xs text-gray-700">Home / Away odds. Your side highlighted in green.</p>
          </div>
        ) : (
          <div className="bg-yellow-900/20 border border-yellow-900/40 rounded-lg px-3 py-2 flex items-center gap-2">
            <span className="text-yellow-600 text-xs">⚠</span>
            <span className="text-xs text-yellow-700">Simulated odds — no live market data for this game</span>
          </div>
        )
      ))}

      {/* Action toggles */}
      <div className="flex flex-wrap gap-3 text-xs">
        {showKelly && (
          <button onClick={() => setShowKellyCalc(o => !o)}
            className="text-brand-400 hover:text-brand-300 transition-colors">
            {showKellyCalc ? '▲ Hide Kelly calc' : '▼ Kelly stake calc'}
          </button>
        )}
        {narrative && (
          <button onClick={() => setShowNarrative(o => !o)}
            className="text-brand-400 hover:text-brand-300 transition-colors">
            {showNarrative ? '▲ Hide AI analysis' : '▼ AI analysis'}
          </button>
        )}
      </div>

      {showKellyCalc && <KellyCalc pick={pick} />}

      {showNarrative && narrative && (
        <p className="text-sm text-gray-300 leading-relaxed border-l-2 border-brand-700 pl-3">
          {narrative}
        </p>
      )}

      {/* H2H + News */}
      <H2HPanel homeTeam={pick.home_team} awayTeam={pick.away_team} />
      <NewsPanel team={(isTotals || isDraw) ? pick.home_team : pick.bet_team} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Parlay Card
// ---------------------------------------------------------------------------
function ParlayCard({ parlay }) {
  if (!parlay?.legs?.length) return null
  return (
    <div className="bg-navy-800 border border-yellow-800/60 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-yellow-300">Suggested Parlay</h3>
        <div className="text-right">
          <div className="text-lg font-bold text-yellow-400">{parlay.combined_odds}x</div>
          <div className="text-xs text-gray-500">implied {pct(parlay.implied_prob)}</div>
        </div>
      </div>
      <div className="space-y-2">
        {parlay.legs.map((leg, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="text-gray-200 font-medium">{leg.team}</span>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded-full ${TIER_STYLES[leg.tier] || TIER_STYLES.Lean}`}>{leg.tier}</span>
              <span className="text-gray-400">{leg.odds}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-600">Parlays multiply risk significantly. Use a small fraction of your normal unit.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Narrative parser
// ---------------------------------------------------------------------------
function parseNarratives(aiText, picks) {
  if (!aiText || !picks.length) return {}
  const narratives = {}
  picks.forEach((pick, i) => {
    const num = i + 1
    const next = i + 2
    const pattern = new RegExp(
      `${num}[.)][\\s\\S]*?(?=${next}[.)]|$)`, 'i'
    )
    const match = aiText.match(pattern)
    if (match) narratives[i] = match[0].replace(/^\d+[.)]\s*/, '').trim()
  })
  return narratives
}

// (TomorrowPicks removed — tomorrow tab now uses same full render as today)

// ---------------------------------------------------------------------------
// Reusable picks section (today + tomorrow share the same render)
// ---------------------------------------------------------------------------
function PicksSection({ apiData, loading, error, narrativeLoading, label }) {
  const picks      = apiData?.picks ?? []
  const parlay     = apiData?.parlay ?? null
  const aiSummary  = apiData?.ai_summary ?? ''
  const modelNote  = apiData?.model_note ?? ''
  const narratives = parseNarratives(aiSummary, picks)

  if (loading) return <Loader />
  if (error)   return <ErrorBox message={error} />

  if (!picks.length) return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-8 text-center text-gray-500">
      <div className="text-3xl mb-3">🎯</div>
      <p className="text-sm">No winner recommendations available for {label}.</p>
      <p className="text-xs mt-1 text-gray-600">
        Check back later — ESPN may not have published the full schedule yet.
      </p>
    </div>
  )

  return (
    <div className="space-y-5">
      {/* Model note */}
      {modelNote && (
        <div className="bg-navy-800 border border-navy-700 rounded-lg px-4 py-3 text-xs text-gray-500">
          {modelNote}
        </div>
      )}

      {/* Pick cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {picks.map((pick, i) => (
          <PickCard key={pick.game_id || i} pick={pick} narrative={null} showKelly={false} />
        ))}
      </div>

      {/* Parlay */}
      {parlay && <ParlayCard parlay={parlay} />}

      {/* Narrative removed in winner mode */}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function Picks() {
  const [tab, setTab] = useState('today')

  // Winner recommendations (no edge/line dependency)
  const todayPicksApi    = useApi('/api/picks/today/winners?top_n=10', { interval: 60000 })
  const tomorrowPicksApi = useApi(tab === 'tomorrow' ? '/api/picks/tomorrow/winners?top_n=10' : null)

  const activePicksApi = tab === 'today' ? todayPicksApi : tomorrowPicksApi
  const mergedData = activePicksApi.data || null

  const { secondsUntilRefresh } = todayPicksApi

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">AI Picks</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Winner probabilities + AI recommended winner per game
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Auto-refresh countdown (today tab only) */}
          {tab === 'today' && secondsUntilRefresh != null && !activePicksApi.loading && (
            <span className="text-xs text-gray-600 border border-navy-700 rounded-lg px-2 py-1">
              odds refresh in {secondsUntilRefresh}s
            </span>
          )}
          <button
            onClick={() => { activePicksApi.refetch() }}
            disabled={activePicksApi.loading}
            className="text-xs text-gray-500 hover:text-gray-300 border border-navy-600 rounded-lg px-3 py-2 disabled:opacity-50">
            {activePicksApi.loading ? 'Refreshing…' : 'Refresh now'}
          </button>
          <a href="/chat"
            className="text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg px-3 py-2 transition-colors">
            Ask AI →
          </a>
        </div>
      </div>

      {/* Today / Tomorrow tabs */}
      <div className="flex gap-2">
        {[['today', "Today's Picks"], ['tomorrow', "Tomorrow's Preview"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
              tab === t
                ? 'bg-brand-600 border-brand-500 text-white'
                : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* Picks — show instantly from fast endpoint */}
      {tab === 'today' && (
        <PicksSection
          apiData={mergedData}
          loading={todayPicksApi.loading}
          error={todayPicksApi.error}
          narrativeLoading={false}
          label="today's slate"
        />
      )}
      {tab === 'tomorrow' && (
        <PicksSection
          apiData={mergedData}
          loading={tomorrowPicksApi.loading}
          error={tomorrowPicksApi.error}
          narrativeLoading={false}
          label="tomorrow's slate"
        />
      )}

      <p className="text-xs text-gray-600 text-center pb-2">
        Predictions are probabilistic — no guarantee of outcome. Bet responsibly. 18+.
      </p>
    </div>
  )
}
