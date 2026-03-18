import clsx from 'clsx'

export default function Card({ title, value, sub, color = 'default', className }) {
  const colors = {
    default: 'border-gray-800',
    green:   'border-brand-600',
    red:     'border-red-700',
    yellow:  'border-yellow-600',
  }
  return (
    <div className={clsx('bg-gray-900 border rounded-xl p-5', colors[color], className)}>
      {title && <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{title}</p>}
      {value !== undefined && (
        <p className="text-2xl font-bold text-gray-100">{value}</p>
      )}
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}
