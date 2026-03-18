import { useState, useEffect, useRef } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from 'recharts'

const API = import.meta.env.VITE_API_BASE || ''

async function apiFetch(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(API + path, opts)
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }))
    throw new Error(err.detail || r.statusText)
  }
  if (r.status === 204) return null
  return r.json()
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function toAmerican(dec) {
  if (!dec || dec <= 1) return null
  const n = dec >= 2
    ? '+' + Math.round((dec - 1) * 100)
    : '-' + Math.round(100 / (dec - 1))
  return n
}

function parseOdds(val) {
  const s = String(val || '').trim()
  if (!s) return null
  const n = parseFloat(s)
  if (isNaN(n)) return null
  if (n >= 100 || n <= -100) {
    return n >= 100 ? parseFloat((n / 100 + 1).toFixed(4)) : parseFloat((-100 / n + 1).toFixed(4))
  }
  return n > 1 ? n : null
}

function fmt(n, d = 2) { return n == null ? '—' : Number(n).toFixed(d) }
function currency(n) {
  if (n == null) return '—'
  const abs = Math.abs(Number(n))
  const sign = Number(n) < 0 ? '-' : '+'
  return sign + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function pct(n) { return n == null ? '—' : (Number(n) * 100).toFixed(1) + '%' }

const RESULT_STYLES = {
  won:  'bg-green-900/60 text-green-300 border-green-700',
  lost: 'bg-red-900/50  text-red-300   border-red-700',
  void: 'bg-gray-800    text-gray-400  border-gray-700',
}

const LEAGUE_META = {
  NBA:            { icon: '🏀', color: 'text-orange-400' },
  MLB:            { icon: '⚾', color: 'text-blue-400'   },
  EPL:            { icon: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', color: 'text-purple-400' },
  UCL:            { icon: '⭐', color: 'text-yellow-400' },
  'Europa League':{ icon: '🟠', color: 'text-orange-300' },
  Bundesliga:     { icon: '🇩🇪', color: 'text-gray-300'  },
  'La Liga':      { icon: '🇪🇸', color: 'text-red-400'   },
  'Liga MX':      { icon: '🇲🇽', color: 'text-green-400' },
}

// ── Odds Button ───────────────────────────────────────────────────────────────
function OddsBtn({ label, odds, selected, onClick, disabled }) {
  const american = odds ? toAmerican(odds) : null
  return (
    <button
      onClick={onClick}
      disabled={disabled || !odds}
      className={`flex flex-col items-center justify-center px-3 py-2 rounded-lg border text-xs font-semibold transition-all min-w-[72px] ${
        selected
          ? 'bg-brand-600 border-brand-400 text-white shadow-lg shadow-brand-900/50 scale-105'
          : odds
          ? 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:border-gray-500 hover:text-white'
          : 'bg-gray-900 border-gray-800 text-gray-700 cursor-not-allowed'
      }`}
    >
      <span className="text-gray-400 text-[10px] font-normal leading-none mb-0.5">{label}</span>
      <span className="leading-tight">{american ?? (odds ? fmt(odds, 2) + 'x' : '—')}</span>
    </button>
  )
}

// ── Single Game Row ───────────────────────────────────────────────────────────
function GameRow({ game, slipKeys, onAddToSlip }) {
  const isSoccer = !['NBA','MLB'].includes(game.league)
  const time = game.date
    ? new Date(game.date).toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
    : ''

  const keyHome  = `${game.home_team}|${game.away_team}|${game.date?.slice(0,10)}|home|moneyline`
  const keyAway  = `${game.home_team}|${game.away_team}|${game.date?.slice(0,10)}|away|moneyline`
  const keyDraw  = `${game.home_team}|${game.away_team}|${game.date?.slice(0,10)}|draw|draw`
  const keyOver  = `${game.home_team}|${game.away_team}|${game.date?.slice(0,10)}|over|total_over`
  const keyUnder = `${game.home_team}|${game.away_team}|${game.date?.slice(0,10)}|under|total_under`

  function addLeg(side, betType, odds, label) {
    if (!odds) return
    onAddToSlip({
      key: `${game.home_team}|${game.away_team}|${game.date?.slice(0,10)}|${side}|${betType}`,
      league:    game.league || '',
      sport:     game.league === 'NBA' ? 'nba' : game.league === 'MLB' ? 'mlb' : 'soccer',
      home_team: game.home_team || '',
      away_team: game.away_team || '',
      date:      game.date?.slice(0,10) || '',
      bet_side:  side,
      bet_team:  side === 'home' ? game.home_team : side === 'away' ? game.away_team : label,
      bet_type:  betType,
      odds:      odds,
      label,
    })
  }

  return (
    <div className="px-4 py-3 border-b border-gray-800/60 hover:bg-gray-800/20 transition-colors">
      <div className="flex items-start justify-between gap-4">
        {/* Teams + time */}
        <div className="min-w-0 flex-1">
          <div className="text-xs text-gray-500 mb-1">{time}</div>
          <div className="space-y-1">
            <div className="text-sm font-semibold text-gray-100 leading-tight">{game.home_team}</div>
            <div className="text-xs text-gray-500">vs</div>
            <div className="text-sm font-semibold text-gray-100 leading-tight">{game.away_team}</div>
          </div>
        </div>

        {/* Odds buttons */}
        <div className="flex gap-1.5 flex-wrap justify-end shrink-0">
          {/* Moneylines */}
          <div className="flex flex-col gap-1">
            <OddsBtn label={game.home_team?.split(' ').pop() ?? 'Home'} odds={game.home_odds}
              selected={slipKeys.has(keyHome)}
              onClick={() => addLeg('home','moneyline',game.home_odds, game.home_team)} />
            <OddsBtn label={game.away_team?.split(' ').pop() ?? 'Away'} odds={game.away_odds}
              selected={slipKeys.has(keyAway)}
              onClick={() => addLeg('away','moneyline',game.away_odds, game.away_team)} />
          </div>

          {/* Draw (soccer only) */}
          {isSoccer && (
            <div className="flex flex-col gap-1 justify-center">
              <OddsBtn label="Draw" odds={game.draw_odds}
                selected={slipKeys.has(keyDraw)}
                onClick={() => addLeg('draw','draw',game.draw_odds,'Draw')} />
            </div>
          )}

          {/* O/U */}
          {game.total_line && (
            <div className="flex flex-col gap-1">
              <OddsBtn label={`O ${game.total_line}`} odds={game.over_odds}
                selected={slipKeys.has(keyOver)}
                onClick={() => addLeg('over','total_over',game.over_odds,`Over ${game.total_line}`)} />
              <OddsBtn label={`U ${game.total_line}`} odds={game.under_odds}
                selected={slipKeys.has(keyUnder)}
                onClick={() => addLeg('under','total_under',game.under_odds,`Under ${game.total_line}`)} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── League Section ────────────────────────────────────────────────────────────
function LeagueSection({ league, games, slipKeys, onAddToSlip }) {
  const [collapsed, setCollapsed] = useState(false)
  const meta = LEAGUE_META[league] || { icon: '🏟', color: 'text-gray-400' }

  return (
    <div>
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-gray-900 border-b border-gray-800 sticky top-0 z-10 hover:bg-gray-800/50 transition-colors"
      >
        <span>{meta.icon}</span>
        <span className={`text-xs font-bold uppercase tracking-wider ${meta.color}`}>{league}</span>
        <span className="text-gray-600 text-xs ml-1">({games.length})</span>
        <span className="ml-auto text-gray-600 text-xs">{collapsed ? '▼' : '▲'}</span>
      </button>
      {!collapsed && games.map((g, i) => (
        <GameRow key={i} game={g} slipKeys={slipKeys} onAddToSlip={onAddToSlip} />
      ))}
    </div>
  )
}

// ── Bet Slip ──────────────────────────────────────────────────────────────────
function BetSlip({ legs, onRemove, onClear, onSubmitted, refetchAll }) {
  const [mode, setMode]     = useState('parlay')  // 'straight' | 'parlay'
  const [stake, setStake]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState(null)
  const [success, setSuccess] = useState(null)

  const combinedOdds = legs.reduce((acc, l) => acc * (l.odds || 1), 1)
  const stakeNum = parseFloat(stake) || 0

  const potReturn = mode === 'parlay'
    ? stakeNum * combinedOdds
    : null  // straight: per-leg return

  async function submit() {
    setError(null)
    setSuccess(null)
    if (!stake || stakeNum <= 0) { setError('Enter a stake amount'); return }
    if (legs.length === 0) { setError('Add at least one selection'); return }

    setLoading(true)
    try {
      if (mode === 'parlay') {
        if (legs.length < 2) { setError('Parlay needs at least 2 legs'); setLoading(false); return }
        const date = legs[0].date || new Date().toISOString().slice(0,10)
        await apiFetch('/api/tracker/parlays', 'POST', {
          date,
          stake: stakeNum,
          notes: `${legs.length}-leg parlay`,
          legs: legs.map(l => ({
            league: l.league, sport: l.sport,
            home_team: l.home_team, away_team: l.away_team,
            bet_side: l.bet_side, bet_team: l.bet_team,
            bet_type: l.bet_type, odds: l.odds,
          })),
        })
        setSuccess(`${legs.length}-leg parlay placed! Combined: ${toAmerican(combinedOdds)} · Return: $${potReturn.toFixed(2)}`)
      } else {
        // Straight: one bet per leg
        for (const leg of legs) {
          await apiFetch('/api/tracker/bets', 'POST', {
            date: leg.date || new Date().toISOString().slice(0,10),
            league: leg.league, sport: leg.sport,
            home_team: leg.home_team, away_team: leg.away_team,
            bet_side: leg.bet_side, bet_team: leg.bet_team,
            bet_type: leg.bet_type,
            stake: stakeNum,
            odds: leg.odds,
            notes: '',
          })
        }
        setSuccess(`${legs.length} bet${legs.length > 1 ? 's' : ''} placed!`)
      }
      onClear()
      setStake('')
      refetchAll()
      setTimeout(() => setSuccess(null), 4000)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="text-sm font-bold text-gray-100">Bet Slip</h2>
        {legs.length > 0 && (
          <button onClick={onClear} className="text-xs text-gray-500 hover:text-red-400 transition-colors">
            Clear all
          </button>
        )}
      </div>

      {/* Mode toggle */}
      {legs.length >= 2 && (
        <div className="flex mx-4 mt-3 bg-gray-800 rounded-lg p-0.5">
          {['straight','parlay'].map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                mode === m ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {legs.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10 gap-3">
          <div className="text-4xl opacity-20">🎯</div>
          <p className="text-gray-500 text-sm">Select odds from any game to add to your slip</p>
        </div>
      )}

      {/* Legs */}
      {legs.length > 0 && (
        <div className="flex-1 overflow-y-auto space-y-2 p-3">
          {legs.map(leg => {
            const american = toAmerican(leg.odds)
            return (
              <div key={leg.key} className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-500 truncate">{leg.league} · {leg.home_team} vs {leg.away_team}</div>
                    <div className="text-sm font-semibold text-gray-100 mt-0.5 leading-tight">{leg.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5 capitalize">
                      {leg.bet_type.replace('_', ' ')}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-bold text-brand-400">{american}</div>
                    <div className="text-xs text-gray-600">{fmt(leg.odds,3)}x</div>
                  </div>
                </div>
                <button onClick={() => onRemove(leg.key)}
                  className="mt-2 text-xs text-gray-600 hover:text-red-400 transition-colors">
                  Remove
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Stake + submit */}
      {legs.length > 0 && (
        <div className="border-t border-gray-700 p-4 space-y-3">
          {mode === 'parlay' && legs.length >= 2 && (
            <div className="flex justify-between text-xs text-gray-400">
              <span>Combined odds</span>
              <span className="text-brand-400 font-bold">{toAmerican(combinedOdds)} <span className="text-gray-600">({fmt(combinedOdds,3)}x)</span></span>
            </div>
          )}

          <div>
            <label className="text-xs text-gray-500">
              {mode === 'straight' && legs.length > 1 ? `Stake per bet ($)` : 'Stake ($)'}
            </label>
            <input
              type="number" min="0" step="0.50" value={stake}
              onChange={e => setStake(e.target.value)}
              placeholder="25.00"
              className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:border-brand-500 focus:outline-none"
            />
          </div>

          {/* Quick stake buttons */}
          <div className="flex gap-1.5">
            {[10,25,50,100].map(v => (
              <button key={v} onClick={() => setStake(String(v))}
                className="flex-1 py-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 text-xs hover:bg-gray-700 hover:text-gray-200 transition-colors">
                ${v}
              </button>
            ))}
          </div>

          {/* Payout preview */}
          {stakeNum > 0 && (
            <div className="bg-gray-800/50 rounded-lg px-3 py-2 space-y-1">
              {mode === 'parlay' ? (
                <>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">To win</span>
                    <span className="text-green-400 font-bold">+${(stakeNum * (combinedOdds - 1)).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Total return</span>
                    <span className="text-gray-200">${(stakeNum * combinedOdds).toFixed(2)}</span>
                  </div>
                </>
              ) : (
                legs.map(l => (
                  <div key={l.key} className="flex justify-between text-xs">
                    <span className="text-gray-500 truncate mr-2">{l.label}</span>
                    <span className="text-green-400 shrink-0">+${(stakeNum * (l.odds - 1)).toFixed(2)}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {error   && <p className="text-red-400 text-xs">{error}</p>}
          {success && <p className="text-green-400 text-xs font-medium">{success}</p>}

          <button onClick={submit} disabled={loading}
            className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold py-3 rounded-xl text-sm transition-colors shadow-lg shadow-brand-900/40">
            {loading ? 'Placing…'
              : mode === 'parlay' ? `Place Parlay (${legs.length} legs)`
              : `Place ${legs.length > 1 ? legs.length + ' Bets' : 'Bet'}`}
          </button>
        </div>
      )}
    </div>
  )
}

// ── My Bets panel ─────────────────────────────────────────────────────────────
function MyBets({ bets, parlays, betsLoading, parlaysLoading, refetchAll }) {
  const [tab, setTab] = useState('all')  // 'all' | 'pending' | 'settled'
  const [actionError, setActionError] = useState(null)

  const allItems = [
    ...bets.map(b => ({ ...b, _kind: 'straight' })),
    ...parlays.map(p => ({ ...p, _kind: 'parlay'   })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id - a.id))

  const filtered = tab === 'all'     ? allItems
    : tab === 'pending'  ? allItems.filter(x => !x.result)
    : allItems.filter(x => x.result)

  async function settle(kind, id, result) {
    setActionError(null)
    try {
      if (kind === 'straight') await apiFetch(`/api/tracker/bets/${id}/settle`, 'PATCH', { result })
      else                     await apiFetch(`/api/tracker/parlays/${id}/settle`, 'PATCH', { result })
      refetchAll()
    } catch (e) { setActionError(e.message) }
  }

  async function del(kind, id) {
    if (!window.confirm('Delete this bet?')) return
    setActionError(null)
    try {
      if (kind === 'straight') await apiFetch(`/api/tracker/bets/${id}`, 'DELETE')
      else                     await apiFetch(`/api/tracker/parlays/${id}`, 'DELETE')
      refetchAll()
    } catch (e) { setActionError(e.message) }
  }

  if (betsLoading || parlaysLoading) return <Loader />

  return (
    <div className="space-y-3">
      {actionError && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-3 py-2 text-xs text-red-300 flex justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-200 ml-2">✕</button>
        </div>
      )}
      {/* Tabs */}
      <div className="flex gap-1 bg-gray-800/50 rounded-lg p-1 w-fit">
        {[['all','All'],['pending','Pending'],['settled','Settled']].map(([v,label]) => (
          <button key={v} onClick={() => setTab(v)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === v ? 'bg-gray-700 text-gray-100' : 'text-gray-500 hover:text-gray-300'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-gray-600 text-sm text-center py-8">No bets here yet.</p>
      )}

      <div className="space-y-2">
        {filtered.map(item => {
          const isParlay = item._kind === 'parlay'
          const isPending = !item.result
          const oddsVal = isParlay ? item.combined_odds : item.odds
          const american = oddsVal ? toAmerican(oddsVal) : null

          return (
            <div key={`${item._kind[0]}${item.id}`}
              className={`bg-gray-900 border rounded-xl p-4 transition-colors ${
                item.result === 'won'  ? 'border-green-800/50' :
                item.result === 'lost' ? 'border-red-800/40'   :
                'border-gray-800'
              }`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {/* Header row */}
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    {isParlay ? (
                      <span className="text-xs bg-purple-900/50 border border-purple-700/60 text-purple-300 px-2 py-0.5 rounded-full font-semibold">
                        {item.legs?.length ?? '?'}-Leg Parlay
                      </span>
                    ) : (
                      <span className="text-xs bg-gray-800 border border-gray-700 text-gray-400 px-2 py-0.5 rounded-full capitalize">
                        {item.bet_type?.replace('_',' ') || 'ML'}
                      </span>
                    )}
                    <span className="text-xs text-gray-600">{item.league || item.sport}</span>
                    <span className="text-xs text-gray-600">{item.date?.slice(0,10)}</span>
                  </div>

                  {/* Main label */}
                  {isParlay ? (
                    <div className="space-y-0.5">
                      {item.legs?.map((l, i) => (
                        <div key={i} className="text-xs text-gray-300 flex items-center gap-1">
                          <span className="text-gray-600">#{i+1}</span>
                          <span className="font-medium">{l.bet_team}</span>
                          <span className="text-gray-600">({l.home_team} vs {l.away_team})</span>
                          <span className="text-brand-400 ml-auto">{toAmerican(l.odds)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div>
                      <span className="text-sm font-bold text-gray-100">{item.bet_team}</span>
                      <span className="text-xs text-gray-500 ml-2">{item.home_team} vs {item.away_team}</span>
                    </div>
                  )}
                </div>

                {/* Right side: odds + result */}
                <div className="text-right shrink-0 space-y-1">
                  <div className="text-sm font-bold text-brand-400">{american}</div>
                  <div className="text-xs text-gray-600">${fmt(item.stake)} stake</div>
                  {item.result ? (
                    <div className={`text-xs font-bold px-2 py-0.5 rounded-full border inline-block ${RESULT_STYLES[item.result] || ''}`}>
                      {item.result.toUpperCase()}
                    </div>
                  ) : (
                    <div className="text-xs text-yellow-500/70 italic">Pending</div>
                  )}
                  {item.pnl != null && (
                    <div className={`text-sm font-bold ${item.pnl > 0 ? 'text-green-400' : item.pnl < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                      {currency(item.pnl)}
                    </div>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-800/60">
                {isPending ? (
                  <>
                    <span className="text-xs text-gray-600 mr-1">Result:</span>
                    {['won','lost','void'].map(r => (
                      <button key={r} onClick={() => settle(item._kind, item.id, r)}
                        className={`text-xs px-3 py-1 rounded-lg border font-medium transition-colors ${
                          r === 'won'  ? 'bg-green-900/40 hover:bg-green-800/60 text-green-300 border-green-800' :
                          r === 'lost' ? 'bg-red-900/30  hover:bg-red-800/50   text-red-300   border-red-800'   :
                                         'bg-gray-800    hover:bg-gray-700     text-gray-400  border-gray-700'
                        }`}>
                        {r.charAt(0).toUpperCase() + r.slice(1)}
                      </button>
                    ))}
                  </>
                ) : (
                  <button onClick={() => del(item._kind, item.id)}
                    className="text-xs text-gray-700 hover:text-red-400 transition-colors ml-auto">
                    Delete
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Summary strip ─────────────────────────────────────────────────────────────
function SummaryStrip({ summary }) {
  if (!summary) return null
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
      {[
        { label: 'Bets',     value: (summary.straight_bets ?? 0) + (summary.parlays ?? 0) },
        { label: 'Pending',  value: summary.pending, dim: true },
        { label: 'Hit Rate', value: pct(summary.hit_rate) },
        { label: 'P&L', value: currency(summary.total_pnl),
          color: summary.total_pnl > 0 ? 'text-green-400' : summary.total_pnl < 0 ? 'text-red-400' : '' },
        { label: 'ROI',      value: pct(summary.roi),
          color: summary.roi > 0 ? 'text-green-400' : summary.roi < 0 ? 'text-red-400' : '' },
        { label: 'Staked',   value: summary.total_staked ? '$'+fmt(summary.total_staked) : '$0.00' },
      ].map(c => (
        <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-3 text-center">
          <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-0.5">{c.label}</div>
          <div className={`text-base font-bold ${c.color || (c.dim ? 'text-gray-500' : 'text-gray-100')}`}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Tracker() {
  const [slip, setSlip]         = useState([])    // bet slip legs
  const [sportFilter, setSport] = useState('all') // 'all' | 'nba' | 'soccer' | 'mlb'
  const [rightTab, setRightTab] = useState('slip') // 'slip' | 'mybets'

  const { data: scheduleData, loading: schedLoading } = useApi('/api/schedule/games?days=3')
  const { data: oddsData }  = useApi('/api/odds/live')
  const { data: summaryData,  refetch: refetchSummary } = useApi('/api/tracker/summary')
  const { data: betsData,    loading: betsLoading,    refetch: refetchBets    } = useApi('/api/tracker/bets?limit=200')
  const { data: parlaysData, loading: parlaysLoading, refetch: refetchParlays } = useApi('/api/tracker/parlays?limit=100')
  const { data: equityData } = useApi('/api/tracker/equity')

  const bets    = betsData?.bets    ?? []
  const parlays = parlaysData?.parlays ?? []
  const equity  = equityData ?? []

  function refetchAll() { refetchSummary(); refetchBets(); refetchParlays() }

  // Build odds lookup from /api/odds/live keyed by normalized team names
  const oddsLookup = {}
  for (const g of (oddsData?.games ?? [])) {
    const key = `${(g.home_team||'').toLowerCase().trim()}|${(g.away_team||'').toLowerCase().trim()}`
    oddsLookup[key] = g
  }

  // Merge live odds into schedule games
  const allGames = (scheduleData?.games ?? []).map(g => {
    const key = `${(g.home_team||'').toLowerCase().trim()}|${(g.away_team||'').toLowerCase().trim()}`
    const live = oddsLookup[key]
    if (!live) return g
    return {
      ...g,
      home_odds:  live.home_odds  ?? g.home_odds,
      away_odds:  live.away_odds  ?? g.away_odds,
      draw_odds:  live.draw_odds  ?? g.draw_odds,
      total_line: live.total_line ?? g.total_line,
      over_odds:  live.over_odds  ?? g.over_odds,
      under_odds: live.under_odds ?? g.under_odds,
    }
  })
  const filteredGames = sportFilter === 'all' ? allGames
    : sportFilter === 'nba'    ? allGames.filter(g => g.league === 'NBA')
    : sportFilter === 'mlb'    ? allGames.filter(g => g.league === 'MLB')
    : allGames.filter(g => !['NBA','MLB'].includes(g.league))

  const byLeague = {}
  for (const g of filteredGames) {
    const l = g.league || 'Other'
    if (!byLeague[l]) byLeague[l] = []
    byLeague[l].push(g)
  }

  const slipKeys = new Set(slip.map(l => l.key))

  function addToSlip(leg) {
    setSlip(prev => {
      const exists = prev.find(l => l.key === leg.key)
      if (exists) return prev.filter(l => l.key !== leg.key) // toggle off
      return [...prev, leg]
    })
    setRightTab('slip')
  }

  function removeFromSlip(key) { setSlip(prev => prev.filter(l => l.key !== key)) }
  function clearSlip()         { setSlip([]) }

  const pendingCount = bets.filter(b => !b.result).length + parlays.filter(p => !p.result).length

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Bet Tracker</h1>
          <p className="text-sm text-gray-500 mt-0.5">Pick games like a sportsbook · straight bets or parlays</p>
        </div>
        <button onClick={refetchAll}
          className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded-lg px-3 py-2">
          Refresh
        </button>
      </div>

      {/* Summary */}
      <SummaryStrip summary={summaryData} />

      {/* P&L curve (collapsed by default if no data) */}
      {equity.length > 1 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 className="text-xs text-gray-500 uppercase tracking-wider mb-3">P&amp;L Curve</h2>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={equity}>
              <defs>
                <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0}    />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="date" tick={{ fill:'#4b5563', fontSize:9 }} tickFormatter={v=>v?.slice(5,10)} />
              <YAxis tick={{ fill:'#4b5563', fontSize:9 }} tickFormatter={v=>'$'+v.toFixed(0)} width={45} />
              <Tooltip contentStyle={{ background:'#111827', border:'1px solid #374151' }}
                labelStyle={{ color:'#9ca3af' }}
                formatter={v=>['$'+Number(v).toFixed(2),'Running P&L']} />
              <ReferenceLine y={0} stroke="#374151" />
              <Area type="monotone" dataKey="running_pnl" stroke="#22c55e" fill="url(#pnlGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Main sportsbook layout */}
      <div className="flex gap-4 items-start">

        {/* LEFT: games list */}
        <div className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {/* Sport filter tabs */}
          <div className="flex border-b border-gray-800 bg-gray-900">
            {[
              { id:'all',    label:'All Games' },
              { id:'nba',    label:'🏀 NBA' },
              { id:'mlb',    label:'⚾ MLB' },
              { id:'soccer', label:'⚽ Soccer' },
            ].map(t => (
              <button key={t.id} onClick={() => setSport(t.id)}
                className={`px-4 py-2.5 text-xs font-medium transition-colors border-b-2 ${
                  sportFilter === t.id
                    ? 'border-brand-500 text-gray-100 bg-gray-800/30'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}>
                {t.label}
                {t.id === 'all' && <span className="ml-1 text-gray-600">({allGames.length})</span>}
              </button>
            ))}
          </div>

          {/* Column headers */}
          <div className="flex items-center justify-between px-4 py-2 bg-gray-800/40 border-b border-gray-800 text-[10px] text-gray-600 uppercase tracking-wider">
            <span>Match</span>
            <span>Moneyline · Draw · O/U</span>
          </div>

          {/* Games */}
          <div className="max-h-[60vh] overflow-y-auto">
            {schedLoading && (
              <div className="py-12 text-center text-gray-500 text-sm">Loading games…</div>
            )}
            {!schedLoading && Object.keys(byLeague).length === 0 && (
              <div className="py-12 text-center text-gray-600 text-sm">No upcoming games found.</div>
            )}
            {Object.entries(byLeague).map(([league, games]) => (
              <LeagueSection
                key={league} league={league} games={games}
                slipKeys={slipKeys} onAddToSlip={addToSlip}
              />
            ))}
          </div>
        </div>

        {/* RIGHT: bet slip + my bets */}
        <div className="w-80 shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden sticky top-4"
             style={{ maxHeight: 'calc(100vh - 120px)' }}>
          {/* Tab switcher */}
          <div className="flex border-b border-gray-800">
            <button onClick={() => setRightTab('slip')}
              className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${rightTab === 'slip' ? 'bg-gray-800 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}>
              Bet Slip {slip.length > 0 && <span className="ml-1 bg-brand-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">{slip.length}</span>}
            </button>
            <button onClick={() => setRightTab('mybets')}
              className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${rightTab === 'mybets' ? 'bg-gray-800 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}>
              My Bets {pendingCount > 0 && <span className="ml-1 bg-yellow-600/80 text-white text-[10px] px-1.5 py-0.5 rounded-full">{pendingCount}</span>}
            </button>
          </div>

          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 185px)' }}>
            {rightTab === 'slip' ? (
              <BetSlip
                legs={slip}
                onRemove={removeFromSlip}
                onClear={clearSlip}
                onSubmitted={() => setRightTab('mybets')}
                refetchAll={refetchAll}
              />
            ) : (
              <div className="p-3">
                <MyBets
                  bets={bets} parlays={parlays}
                  betsLoading={betsLoading} parlaysLoading={parlaysLoading}
                  refetchAll={refetchAll}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
