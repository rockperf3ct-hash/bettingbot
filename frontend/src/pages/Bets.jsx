import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import Loader from '../components/Loader'
import ErrorBox from '../components/ErrorBox'
import clsx from 'clsx'

function Badge({ value }) {
  if (!value) return <span className="text-gray-600">—</span>
  const colors = {
    home: 'bg-blue-900 text-blue-300',
    away: 'bg-purple-900 text-purple-300',
  }
  return (
    <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', colors[value] ?? 'bg-gray-800 text-gray-400')}>
      {value}
    </span>
  )
}

function WonBadge({ value }) {
  if (value === null || value === undefined) return <span className="text-gray-600">—</span>
  return value
    ? <span className="text-brand-400 font-semibold text-xs">WIN</span>
    : <span className="text-red-400 font-semibold text-xs">LOSS</span>
}

function pct(n) {
  if (n == null) return '—'
  return (Number(n) * 100).toFixed(1) + '%'
}
function dec(n, d = 2) {
  if (n == null) return '—'
  return Number(n).toFixed(d)
}

export default function Bets() {
  const { data: leagueData } = useApi('/api/bets/leagues')
  const [league, setLeague] = useState('')
  const [side, setSide]     = useState('')
  const [page, setPage]     = useState(0)
  const limit = 50

  const params = new URLSearchParams({ limit, offset: page * limit })
  if (league) params.set('league', league)
  if (side)   params.set('side', side)

  const { data, loading, error } = useApi(`/api/bets?${params}`)

  const bets   = data?.bets ?? []
  const total  = data?.total ?? 0
  const pages  = Math.ceil(total / limit)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-100">Bets</h1>
        <div className="flex gap-3">
          <select
            value={league}
            onChange={e => { setLeague(e.target.value); setPage(0) }}
            className="bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-300 px-3 py-2 focus:outline-none"
          >
            <option value="">All leagues</option>
            {leagueData?.leagues?.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select
            value={side}
            onChange={e => { setSide(e.target.value); setPage(0) }}
            className="bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-300 px-3 py-2 focus:outline-none"
          >
            <option value="">All sides</option>
            <option value="home">Home</option>
            <option value="away">Away</option>
          </select>
        </div>
      </div>

      {loading && <Loader />}
      {error   && <ErrorBox message={error} />}

      {!loading && !error && (
        <>
          <p className="text-xs text-gray-500">{total} bets matched</p>
          <div className="overflow-x-auto rounded-xl border border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-500 text-xs uppercase tracking-wider">
                <tr>
                  {['Date','League','Home','Away','Side','Edge','Odds','Stake','PnL','Bankroll','CLV%','Result'].map(h => (
                    <th key={h} className="px-4 py-3 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {bets.map((b, i) => (
                  <tr key={i} className="bg-gray-950 hover:bg-gray-900 transition-colors">
                    <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{String(b.date ?? '').slice(0, 10)}</td>
                    <td className="px-4 py-2 text-gray-400">{b.league ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-200">{b.home_team ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-200">{b.away_team ?? '—'}</td>
                    <td className="px-4 py-2"><Badge value={b.bet_side} /></td>
                    <td className="px-4 py-2 text-gray-300">{b.bet_side ? pct(b.edge) : '—'}</td>
                    <td className="px-4 py-2 text-gray-300">{b.bet_side ? dec(b.odds) : '—'}</td>
                    <td className="px-4 py-2 text-gray-300">{b.bet_side ? '$' + dec(b.stake) : '—'}</td>
                    <td className={clsx('px-4 py-2 font-medium', b.pnl > 0 ? 'text-brand-400' : b.pnl < 0 ? 'text-red-400' : 'text-gray-600')}>
                      {b.bet_side ? (b.pnl >= 0 ? '+' : '') + '$' + dec(b.pnl) : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-300">${dec(b.bankroll)}</td>
                    <td className="px-4 py-2 text-gray-400">{b.clv_pct != null ? pct(b.clv_pct) : '—'}</td>
                    <td className="px-4 py-2"><WonBadge value={b.won} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="flex items-center gap-3 justify-center pt-2">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="px-4 py-1.5 bg-gray-800 rounded-lg text-sm disabled:opacity-30 hover:bg-gray-700">
                Prev
              </button>
              <span className="text-xs text-gray-500">Page {page + 1} / {pages}</span>
              <button onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}
                className="px-4 py-1.5 bg-gray-800 rounded-lg text-sm disabled:opacity-30 hover:bg-gray-700">
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
