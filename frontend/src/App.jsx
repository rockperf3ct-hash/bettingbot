import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { useState, createContext, useContext } from 'react'
import Dashboard  from './pages/Dashboard'
import Live       from './pages/Live'
import Model      from './pages/Model'
import Standings  from './pages/Standings'
import Picks      from './pages/Picks'
import Profile    from './pages/Profile'
import History    from './pages/History'
import Chat       from './pages/Chat'
import Schedule   from './pages/Schedule'
import Props      from './pages/Props'
import TestLiveCourt from './pages/TestLiveCourt'
import { useTheme } from './hooks/useTheme'

// ---------------------------------------------------------------------------
// Bet Slip Context — shared across entire app
// ---------------------------------------------------------------------------
export const BetSlipContext = createContext({
  slip: [],
  addBet: () => {},
  removeBet: () => {},
  clearSlip: () => {},
  slipOpen: false,
  setSlipOpen: () => {},
})

export function useBetSlip() { return useContext(BetSlipContext) }

function BetSlipProvider({ children }) {
  const [slip, setSlip]         = useState([])
  const [slipOpen, setSlipOpen] = useState(false)

  const addBet = (bet) => {
    // Dedupe by game+side
    setSlip(prev => {
      const key = `${bet.home_team}|${bet.away_team}|${bet.bet_side}`
      const exists = prev.find(b => `${b.home_team}|${b.away_team}|${b.bet_side}` === key)
      if (exists) return prev  // already in slip
      const updated = [...prev, { ...bet, stake: '' }]
      return updated
    })
    setSlipOpen(true)
  }

  const removeBet = (idx) => setSlip(prev => prev.filter((_, i) => i !== idx))
  const clearSlip = () => setSlip([])

  return (
    <BetSlipContext.Provider value={{ slip, addBet, removeBet, clearSlip, slipOpen, setSlipOpen }}>
      {children}
    </BetSlipContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Bet Slip panel (slides in from right)
// ---------------------------------------------------------------------------
function BetSlipPanel() {
  const { slip, removeBet, clearSlip, slipOpen, setSlipOpen } = useBetSlip()
  const [stakes, setStakes] = useState({})
  const [placing, setPlacing] = useState(false)
  const [placed, setPlaced]   = useState([])
  const [error, setError]     = useState(null)

  const totalStake = Object.values(stakes).reduce((s, v) => s + (parseFloat(v) || 0), 0)

  const updateStake = (idx, val) => setStakes(p => ({ ...p, [idx]: val }))

  const toAmerican = (dec) => {
    if (!dec || dec <= 1) return '—'
    return dec >= 2
      ? '+' + Math.round((dec - 1) * 100)
      : '-' + Math.round(100 / (dec - 1))
  }

  const potentialWin = (bet, idx) => {
    const stake = parseFloat(stakes[idx]) || 0
    return stake > 0 && bet.odds > 1 ? ((bet.odds - 1) * stake).toFixed(2) : null
  }

  const handlePlace = async () => {
    setPlacing(true)
    setError(null)
    const results = []
    for (let i = 0; i < slip.length; i++) {
      const bet = slip[i]
      const stake = parseFloat(stakes[i]) || 0
      if (!stake) continue
      try {
        const r = await fetch('http://localhost:8000/api/tracker/bets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date:       new Date().toISOString().slice(0, 10),
            league:     bet.league || '',
            sport:      bet.sport || '',
            home_team:  bet.home_team || '',
            away_team:  bet.away_team || '',
            bet_side:   bet.bet_side || '',
            bet_team:   bet.bet_team || '',
            bet_type:   bet.bet_type || 'moneyline',
            stake,
            odds:       bet.odds || 2.0,
            model_prob: bet.model_prob || null,
            edge:       bet.edge || null,
            notes:      bet.notes || '',
          }),
        })
        if (!r.ok) { const e = await r.json(); throw new Error(e.detail || 'Failed') }
        results.push(await r.json())
      } catch (e) { setError(e.message); setPlacing(false); return }
    }
    setPlaced(results)
    clearSlip()
    setStakes({})
    setPlacing(false)
  }

  if (!slipOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end pointer-events-none">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 pointer-events-auto"
        onClick={() => setSlipOpen(false)}
      />

      {/* Slip panel */}
      <div className="relative w-80 bg-navy-900 border-l border-navy-700 flex flex-col h-full pointer-events-auto animate-slide-in shadow-slip">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-navy-700 bg-navy-800">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">Bet Slip</span>
            {slip.length > 0 && (
              <span className="bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                {slip.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {slip.length > 0 && (
              <button onClick={clearSlip} className="text-xs text-gray-500 hover:text-gray-300">
                Clear all
              </button>
            )}
            <button onClick={() => setSlipOpen(false)} className="text-gray-400 hover:text-white text-lg leading-none">
              ×
            </button>
          </div>
        </div>

        {/* Placed confirmation */}
        {placed.length > 0 && (
          <div className="mx-4 mt-3 bg-green-900/40 border border-green-800 rounded-lg p-3 animate-fade-in">
            <p className="text-xs text-green-400 font-semibold">
              {placed.length} bet{placed.length > 1 ? 's' : ''} placed successfully
            </p>
            <button onClick={() => setPlaced([])} className="text-xs text-gray-500 mt-1 hover:text-gray-300">
              Dismiss
            </button>
          </div>
        )}

        {/* Empty state */}
        {slip.length === 0 && placed.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-3">
            <div className="text-3xl opacity-30">🎯</div>
            <p className="text-sm text-gray-500">
              Click any odds button to add a bet to your slip
            </p>
          </div>
        )}

        {/* Bet list */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {slip.map((bet, i) => (
            <div key={i} className="bg-navy-800 border border-navy-700 rounded-xl p-3 space-y-2">
              {/* Bet header */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-bold text-white">{bet.bet_team}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {bet.bet_type_label || bet.bet_type} · {bet.league}
                  </p>
                  <p className="text-xs text-gray-600">
                    {bet.home_team} vs {bet.away_team}
                  </p>
                </div>
                <button onClick={() => removeBet(i)} className="text-gray-600 hover:text-gray-300 text-sm leading-none shrink-0 mt-0.5">
                  ×
                </button>
              </div>

              {/* Odds + edge */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-white font-bold text-sm">{toAmerican(bet.odds)}</span>
                <span className="text-gray-500">{bet.odds?.toFixed(2)} dec</span>
                {bet.edge != null && (
                  <span className={`stat-chip ${bet.edge >= 0.05 ? 'green' : 'yellow'}`}>
                    {(bet.edge * 100).toFixed(1)}% edge
                  </span>
                )}
              </div>

              {/* Stake input */}
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={stakes[i] || ''}
                    onChange={e => updateStake(i, e.target.value)}
                    placeholder="Stake"
                    className="w-full bg-navy-700 border border-navy-600 rounded-lg pl-6 pr-2 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                </div>
                {potentialWin(bet, i) && (
                  <div className="text-right">
                    <p className="text-xs text-gray-500">Win</p>
                    <p className="text-xs font-bold text-green-400">+${potentialWin(bet, i)}</p>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        {slip.length > 0 && (
          <div className="border-t border-navy-700 px-4 py-3 space-y-3 bg-navy-900">
            {error && (
              <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-2 py-1.5">
                {error}
              </p>
            )}
            {totalStake > 0 && (
              <div className="flex justify-between text-xs text-gray-400">
                <span>Total stake</span>
                <span className="text-white font-semibold">${totalStake.toFixed(2)}</span>
              </div>
            )}
            <button
              onClick={handlePlace}
              disabled={placing || totalStake === 0}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-navy-700 disabled:text-gray-600 text-white font-bold py-3 rounded-xl transition-colors text-sm"
            >
              {placing ? 'Placing…' : `Place Bet${slip.length > 1 ? 's' : ''}`}
            </button>
            <p className="text-xs text-gray-600 text-center">
              For tracking purposes only — not real money
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const NAV_ITEMS = [
  { to: '/',           label: 'Dashboard' },
  { to: '/picks',      label: 'AI Picks'  },
  { to: '/props',      label: 'Props'     },
  { to: '/schedule',   label: 'Schedule'  },
  { to: '/live',       label: 'Live'      },
  { to: '/profile',    label: 'My Bets'   },
  { to: '/chat',       label: 'AI Chat'   },
  { to: '/standings',  label: 'Standings' },
  { to: '/history',    label: 'History'   },
  { to: '/model',      label: 'Model'     },
]

function Nav() {
  const { slip, slipOpen, setSlipOpen } = useBetSlip()
  const { isDark, toggle } = useTheme()

  return (
    <header className="bg-navy-900 border-b border-navy-700 px-4 py-0 flex items-center justify-between gap-4 h-14 sticky top-0 z-40">
      {/* Logo */}
      <div className="flex items-center gap-4 shrink-0">
        <span className="text-blue-400 font-extrabold text-lg tracking-tight">
          STATSBET
        </span>
      </div>

      {/* Nav links */}
      <nav className="flex items-center gap-1 overflow-x-auto flex-1 hide-scrollbar">
        {NAV_ITEMS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              isActive
                ? 'nav-link active whitespace-nowrap'
                : 'nav-link whitespace-nowrap'
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Right controls */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Theme toggle */}
        <button
          onClick={toggle}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-300 hover:bg-navy-700 transition-colors"
          title={isDark ? 'Light mode' : 'Dark mode'}
        >
          {isDark ? '☀️' : '🌙'}
        </button>

        {/* Bet slip button */}
        <button
          onClick={() => setSlipOpen(o => !o)}
          className="relative flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-3 py-2 rounded-lg transition-colors"
        >
          <span>Slip</span>
          {slip.length > 0 && (
            <span className="bg-white text-blue-700 rounded-full w-4 h-4 flex items-center justify-center text-xs font-black">
              {slip.length}
            </span>
          )}
        </button>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------
export default function App() {
  return (
    <BetSlipProvider>
      <div className="min-h-screen flex flex-col bg-navy-950">
        <Nav />
        <main className="flex-1 p-4 md:p-6 max-w-[1400px] mx-auto w-full">
          <Routes>
            <Route path="/"          element={<Dashboard />} />
            <Route path="/picks"     element={<Picks />}     />
            <Route path="/props"     element={<Props />}     />
            <Route path="/schedule"  element={<Schedule />}  />
            <Route path="/live"      element={<Live />}      />
            <Route path="/profile"   element={<Profile />}   />
            <Route path="/chat"      element={<Chat />}      />
            <Route path="/standings" element={<Standings />} />
            <Route path="/history"   element={<History />}   />
            <Route path="/model"     element={<Model />}     />
            <Route path="/testlivecourt" element={<TestLiveCourt />} />
          </Routes>
        </main>
        <footer className="border-t border-navy-800 text-center text-xs text-navy-600 py-3">
          STATSBET · ML-powered picks · For tracking purposes only · Bet responsibly · 18+
        </footer>
        <BetSlipPanel />
      </div>
    </BetSlipProvider>
  )
}
