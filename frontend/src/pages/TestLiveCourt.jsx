import { useEffect, useMemo, useState } from 'react'
import { LiveCourtAnimation } from './Props'

const HOME = {
  id: '14',
  abbr: 'LAL',
  name: 'Los Angeles Lakers',
  color: '552583',
}

const AWAY = {
  id: '2',
  abbr: 'BOS',
  name: 'Boston Celtics',
  color: '007a33',
}

const DEMO_PLAYS = [
  {
    sequence_number: 101,
    wallclock: '2026-03-15T01:03:00Z',
    text: 'Jayson Tatum makes 3-point jumper (Jrue Holiday assists)',
    period: 1,
    clock: '10:42',
    is_scoring: true,
    is_shooting: true,
    score_value: 3,
    team_id: AWAY.id,
    team_abbr: AWAY.abbr,
    athlete_name: 'Jayson Tatum',
    athlete_id: '4065648',
    headshot: 'https://a.espncdn.com/i/headshots/nba/players/full/4065648.png',
    x: 15,
    y: 31,
    away_score: 3,
    home_score: 0,
  },
  {
    sequence_number: 102,
    wallclock: '2026-03-15T01:04:00Z',
    text: 'LeBron James misses 3-point pullup jumper',
    period: 1,
    clock: '10:11',
    is_scoring: false,
    is_shooting: true,
    score_value: 0,
    team_id: HOME.id,
    team_abbr: HOME.abbr,
    athlete_name: 'LeBron James',
    athlete_id: '1966',
    headshot: 'https://a.espncdn.com/i/headshots/nba/players/full/1966.png',
    x: 36,
    y: 28,
    away_score: 3,
    home_score: 0,
  },
  {
    sequence_number: 103,
    wallclock: '2026-03-15T01:05:00Z',
    text: 'Kristaps Porzingis makes layup and one (Jayson Tatum assists)',
    period: 1,
    clock: '09:56',
    is_scoring: true,
    is_shooting: true,
    score_value: 2,
    team_id: AWAY.id,
    team_abbr: AWAY.abbr,
    athlete_name: 'Kristaps Porzingis',
    athlete_id: '3102531',
    headshot: 'https://a.espncdn.com/i/headshots/nba/players/full/3102531.png',
    x: 21,
    y: 8,
    away_score: 5,
    home_score: 0,
  },
  {
    sequence_number: 104,
    wallclock: '2026-03-15T01:06:00Z',
    text: 'Austin Reaves makes 3-point jump shot',
    period: 1,
    clock: '09:24',
    is_scoring: true,
    is_shooting: true,
    score_value: 3,
    team_id: HOME.id,
    team_abbr: HOME.abbr,
    athlete_name: 'Austin Reaves',
    athlete_id: '4395627',
    headshot: 'https://a.espncdn.com/i/headshots/nba/players/full/4395627.png',
    x: 40,
    y: 34,
    away_score: 5,
    home_score: 3,
  },
  {
    sequence_number: 105,
    wallclock: '2026-03-15T01:07:00Z',
    text: 'Jaylen Brown misses 3-point jumper blocked by Anthony Davis',
    period: 1,
    clock: '08:59',
    is_scoring: false,
    is_shooting: true,
    score_value: 0,
    team_id: AWAY.id,
    team_abbr: AWAY.abbr,
    athlete_name: 'Jaylen Brown',
    athlete_id: '3917376',
    headshot: 'https://a.espncdn.com/i/headshots/nba/players/full/3917376.png',
    x: 12,
    y: 33,
    away_score: 5,
    home_score: 3,
  },
  {
    sequence_number: 1051,
    wallclock: '2026-03-15T01:07:12Z',
    text: 'Rui Hachimura defensive rebound',
    period: 1,
    clock: '08:55',
    is_scoring: false,
    is_shooting: false,
    score_value: 0,
    team_id: HOME.id,
    team_abbr: HOME.abbr,
    athlete_name: 'Rui Hachimura',
    athlete_id: '4066648',
    headshot: 'https://a.espncdn.com/i/headshots/nba/players/full/4066648.png',
    x: null,
    y: null,
    away_score: 5,
    home_score: 3,
  },
  {
    sequence_number: 106,
    wallclock: '2026-03-15T01:08:00Z',
    text: 'Derrick White makes 3-point jumper (Jayson Tatum assists)',
    period: 1,
    clock: '08:31',
    is_scoring: true,
    is_shooting: true,
    score_value: 3,
    team_id: AWAY.id,
    team_abbr: AWAY.abbr,
    athlete_name: 'Derrick White',
    athlete_id: '3895652',
    headshot: 'https://a.espncdn.com/i/headshots/nba/players/full/3895652.png',
    x: 18,
    y: 30,
    away_score: 8,
    home_score: 3,
  },
  {
    sequence_number: 107,
    wallclock: '2026-03-15T01:09:00Z',
    text: 'Lakers timeout',
    period: 1,
    clock: '08:02',
    is_scoring: false,
    is_shooting: false,
    score_value: 0,
    team_id: HOME.id,
    team_abbr: HOME.abbr,
    athlete_name: '',
    athlete_id: '',
    headshot: '',
    x: null,
    y: null,
    away_score: 8,
    home_score: 3,
  },
]

export default function TestLiveCourt() {
  const [cursor, setCursor] = useState(3)

  useEffect(() => {
    const timer = setInterval(() => {
      setCursor((n) => (n >= DEMO_PLAYS.length ? 3 : n + 1))
    }, 2800)
    return () => clearInterval(timer)
  }, [])

  const demoData = useMemo(() => {
    const chrono = DEMO_PLAYS.slice(0, cursor)
    const latest = chrono[chrono.length - 1]
    const visible = [...chrono].reverse()
    const homeScore = latest?.home_score ?? 0
    const awayScore = latest?.away_score ?? 0

    return {
      event_id: 'demo-lal-bos',
      state: 'STATUS_IN_PROGRESS',
      state_label: `Q1 ${latest?.clock || '12:00'}`,
      period: 1,
      clock: latest?.clock || '12:00',
      is_live: true,
      is_final: false,
      plays: visible,
      last_sequence: latest?.sequence_number || 0,
      total_plays: chrono.length,
      linescore: {
        away: [String(awayScore), '-', '-', '-'],
        home: [String(homeScore), '-', '-', '-'],
      },
      team_stats: {
        [AWAY.abbr]: {
          'Free Throw %': '83.3%',
          'Free Throws': '5/6',
          '2PT %': '45.5%',
          '2PT': '10/22',
          '3PT %': '41.7%',
          '3PT': '5/12',
        },
        [HOME.abbr]: {
          'Free Throw %': '75.0%',
          'Free Throws': '3/4',
          '2PT %': '50.0%',
          '2PT': '9/18',
          '3PT %': '38.5%',
          '3PT': '5/13',
        },
      },
      possession: {
        team_id: latest?.team_id || HOME.id,
        team_abbr: latest?.team_abbr || HOME.abbr,
        side: latest?.team_id === HOME.id ? 'home' : 'away',
        source: latest?.text || '',
        sequence_number: latest?.sequence_number || 0,
      },
      home: { ...HOME, score: String(homeScore), record: '0-0' },
      away: { ...AWAY, score: String(awayScore), record: '0-0' },
      shots: [],
      athletes: {},
      on_court: {},
      win_prob: { home_pct: 48.3, away_pct: 51.7 },
    }
  }, [cursor])

  return (
    <div className="min-h-screen bg-[#070f1f] p-6">
      <div className="max-w-6xl mx-auto space-y-3">
        <h1 className="text-white text-xl font-black tracking-tight">Live Court Test</h1>
        <p className="text-blue-200/70 text-sm">Demo loop with 3PT made/missed events and shooter labels.</p>
        <div className="rounded-2xl border border-blue-900/60 bg-[#0a172d] p-4">
          <LiveCourtAnimation
            eventId="demo-lal-bos"
            isLive={true}
            home={{ ...HOME, score: String(demoData.home.score), logo: '', record: '0-0' }}
            away={{ ...AWAY, score: String(demoData.away.score), logo: '', record: '0-0' }}
            demoData={demoData}
          />
        </div>
      </div>
    </div>
  )
}
