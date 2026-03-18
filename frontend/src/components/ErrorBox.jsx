export default function ErrorBox({ message }) {
  return (
    <div className="bg-red-950 border border-red-800 text-red-300 rounded-xl px-5 py-4 text-sm whitespace-pre-wrap break-words">
      {message}
    </div>
  )
}
