import { useState, useRef, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || ''

// Quick-access prompt suggestions
const SUGGESTIONS = [
  "Which parlay do you recommend for today?",
  "What's the best bet for tomorrow's NBA games?",
  "Explain the top pick's edge and why it's worth betting",
  "What spreads look good today?",
  "Which over/under bets have value?",
  "What's the best 3-leg parlay for this weekend?",
  "How should I size my bets with a $500 bankroll?",
  "Are there any high-value soccer bets today?",
  "What does the model say about the strongest pick?",
  "Tell me which MLB games have value today",
]

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold
        ${isUser ? 'bg-brand-600 text-white' : 'bg-navy-600 text-gray-200'}`}>
        {isUser ? 'You' : 'AI'}
      </div>
      {/* Bubble */}
      <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed
        ${isUser
          ? 'bg-brand-600/80 text-white rounded-tr-sm'
          : 'bg-navy-700 text-gray-200 rounded-tl-sm border border-navy-600'
        }`}>
        {msg.content.split('\n').map((line, i) => (
          <p key={i} className={i > 0 ? 'mt-1' : ''}>{line}</p>
        ))}
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-8 h-8 rounded-full bg-navy-600 text-gray-200 flex items-center justify-center text-sm font-bold">
        AI
      </div>
      <div className="bg-navy-700 border border-navy-600 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1">
        <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  )
}

export default function Chat() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: "Hey! I'm your AI betting analyst. I have access to today's ML picks, live FanDuel/DraftKings odds (moneyline, spreads, totals), and tomorrow's preview. Ask me anything — parlays, value bets, bet sizing, specific games, or strategy.",
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [includeContext, setIncludeContext] = useState(true)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function sendMessage(text) {
    const userText = (text || input).trim()
    if (!userText || loading) return

    setInput('')
    setError(null)

    const userMsg = { role: 'user', content: userText }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setLoading(true)

    // Build history for API (exclude the system greeting)
    const historyForApi = newMessages
      .slice(1)  // skip the initial AI greeting
      .slice(-10) // last 10 messages max
      .map(m => ({ role: m.role, content: m.content }))

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userText,
          history: historyForApi.slice(0, -1), // all except the current user message
          include_context: includeContext,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch (e) {
      setError(e.message)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Sorry, I ran into an error: ${e.message}. Please try again.`,
      }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function clearChat() {
    setMessages([{
      role: 'assistant',
      content: "Chat cleared. Ask me anything about today's picks, odds, parlays, or betting strategy.",
    }])
    setError(null)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">AI Betting Analyst</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Powered by Gemini 3.1 Pro · Live odds + ML picks as context
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={includeContext}
              onChange={e => setIncludeContext(e.target.checked)}
              className="w-3.5 h-3.5 accent-brand-500"
            />
            Inject live odds + picks
          </label>
          <button
            onClick={clearChat}
            className="text-xs text-gray-500 hover:text-gray-300 border border-navy-600 rounded-lg px-3 py-1.5 transition-colors"
          >
            Clear chat
          </button>
        </div>
      </div>

      {/* Quick suggestions */}
      <div className="mb-3 flex flex-wrap gap-2">
        {SUGGESTIONS.slice(0, 5).map((s, i) => (
          <button
            key={i}
            onClick={() => sendMessage(s)}
            disabled={loading}
            className="text-xs bg-navy-700 hover:bg-navy-600 border border-navy-600 text-gray-400 hover:text-gray-200 rounded-full px-3 py-1 transition-colors disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 pb-2 pr-1">
        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
        {loading && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="mt-4 bg-navy-800 border border-navy-600 rounded-xl p-3 flex gap-3 items-end">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask about parlays, specific games, spreads, totals, bet sizing…"
          rows={2}
          disabled={loading}
          className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 resize-none focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={() => sendMessage()}
          disabled={loading || !input.trim()}
          className="shrink-0 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
        >
          {loading ? '…' : 'Send'}
        </button>
      </div>

      {/* More suggestions (collapsible) */}
      <details className="mt-2">
        <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-400 transition-colors">
          More example questions
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {SUGGESTIONS.slice(5).map((s, i) => (
            <button
              key={i}
              onClick={() => sendMessage(s)}
              disabled={loading}
              className="text-xs bg-navy-700 hover:bg-navy-600 border border-navy-600 text-gray-400 hover:text-gray-200 rounded-full px-3 py-1 transition-colors disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>
      </details>

      <p className="text-xs text-gray-700 text-center mt-2">
        AI analysis is not financial advice. Bet responsibly. 18+.
      </p>
    </div>
  )
}
