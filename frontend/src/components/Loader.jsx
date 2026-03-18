export default function Loader({ text = 'Loading...' }) {
  return (
    <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
      <span className="animate-pulse">{text}</span>
    </div>
  )
}
