import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.mjs'

interface Message {
  role: 'user' | 'assistant'
  text: string
}

function App() {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfText, setPdfText] = useState<string>('')
  const [pdfName, setPdfName] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', text: 'Hi! Upload a PDF and ask me anything about it.' },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || file.type !== 'application/pdf') {
      alert('Please upload a PDF file.')
      return
    }

    const url = URL.createObjectURL(file)
    setPdfUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
    setPdfName(file.name)

    // Extract text from all pages
    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    let fullText = ''
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      fullText += content.items
        .map((item: any) => ('str' in item ? item.str : ''))
        .join(' ') + '\n'
    }
    setPdfText(fullText)
    setMessages([
      {
        role: 'assistant',
        text: `"${file.name}" loaded (${pdf.numPages} pages). What do you want to know?`,
      },
    ])
  }

  const sendMessage = async () => {
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', text: userMessage }])
    setLoading(true)

    try {
      console.log('Context being sent:', pdfText.slice(0, 4000))
      console.log('Context length:', pdfText.length)
      const res = await fetch('http://127.0.0.1:8000/chat?mode=azure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          context: pdfText.slice(0, 4000),
          slideNumber: 1,
        }),
      })

      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json()

      if (data.error) throw new Error(data.details || data.error)

      setMessages((prev) => [...prev, { role: 'assistant', text: data.response }])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: `Something went wrong: ${(err as Error).message}` },
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') sendMessage()
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    }
  }, [pdfUrl])

  return (
    <div className="app-shell">
      <section className="pdf-pane">
        <header className="pane-header">
          <h1>Crambot</h1>
          <label className="upload-label" style={{ marginLeft: '0.4rem', marginTop: '0.2rem' }}>
            {pdfName ? pdfName : 'Upload your lecture material'}
            <input type="file" accept="application/pdf" onChange={handleUpload} />
          </label>
        </header>

        <div className="pdf-viewer">
          {pdfUrl ? (
            <iframe title="PDF preview" src={pdfUrl} className="pdf-frame" />
          ) : (
            <div className="empty-state">Upload a PDF to view it here.</div>
          )}
        </div>
      </section>

      <aside className="chat-pane">
        <header className="pane-header">
          <h2>Crambot Chat</h2>
          <p>{pdfText ? 'PDF context loaded ✓' : 'No PDF loaded yet'}</p>
        </header>

        <div className="chat-messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`chat-message ${msg.role}`}>
              {msg.text}
            </div>
          ))}
          {loading && (
            <div className="chat-message assistant loading">
              <span>.</span><span>.</span><span>.</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="chat-input-row">
          <input
            type="text"
            placeholder={pdfText ? 'Ask about the PDF...' : 'Upload a PDF first...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            aria-label="Chat input"
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
        </div>
      </aside>
    </div>
  )
}

export default App