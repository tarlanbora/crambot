/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.mjs'

interface Message {
  role: 'user' | 'assistant'
  text: string
  image?: string
}

interface SelectionRect {
  startX: number
  startY: number
  endX: number
  endY: number
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
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [isSelecting, setIsSelecting] = useState(false)
  const [selection, setSelection] = useState<SelectionRect | null>(null)
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  
  const bottomRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

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
    setCurrentPage(1)
    setSelectedImage(null)
    setSelection(null)

    // Extract text from all pages
    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    setPdfDocument(pdf)
    setTotalPages(pdf.numPages)
    
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

  const renderPage = async (pageNum: number) => {
    if (!pdfDocument || !canvasRef.current) return

    try {
      const page = await pdfDocument.getPage(pageNum)
      const viewport = page.getViewport({ scale: zoom })
      
      const canvas = canvasRef.current
      canvas.width = viewport.width
      canvas.height = viewport.height

      await page.render({
        canvasContext: canvas.getContext('2d')!,
        canvas: canvas,
        viewport: viewport,
      }).promise

      // Clear overlay
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = viewport.width
        overlayCanvasRef.current.height = viewport.height
      }
    } catch (error) {
      console.error('Error rendering page:', error)
    }
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    setSelection({ startX: x, startY: y, endX: x, endY: y })
    setIsSelecting(true)
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isSelecting || !selection) return

    const canvas = overlayCanvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const newSelection = {
      ...selection,
      endX: Math.max(0, Math.min(x, canvas.width)),
      endY: Math.max(0, Math.min(y, canvas.height)),
    }
    setSelection(newSelection)

    // Draw selection rectangle on overlay
    if (overlayCanvasRef.current) {
      const overlayCtx = overlayCanvasRef.current.getContext('2d')!
      overlayCtx.clearRect(0, 0, overlayCanvasRef.current.width, overlayCanvasRef.current.height)

      const minX = Math.min(newSelection.startX, newSelection.endX)
      const minY = Math.min(newSelection.startY, newSelection.endY)
      const width = Math.abs(newSelection.endX - newSelection.startX)
      const height = Math.abs(newSelection.endY - newSelection.startY)

      overlayCtx.fillStyle = 'rgba(100, 150, 255, 0.2)'
      overlayCtx.fillRect(minX, minY, width, height)

      overlayCtx.strokeStyle = 'rgb(100, 150, 255)'
      overlayCtx.lineWidth = 2
      overlayCtx.strokeRect(minX, minY, width, height)
    }
  }

  const handleMouseUp = () => {
    setIsSelecting(false)
  }

  const extractSelectedArea = () => {
    if (!selection || !canvasRef.current) return

    const mainCanvas = canvasRef.current
    const minX = Math.min(selection.startX, selection.endX)
    const minY = Math.min(selection.startY, selection.endY)
    const width = Math.abs(selection.endX - selection.startX)
    const height = Math.abs(selection.endY - selection.startY)

    if (width < 5 || height < 5) {
      alert('Please select a larger area')
      return
    }

    // Create a temporary canvas for the cropped image
    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = width
    cropCanvas.height = height
    const ctx = cropCanvas.getContext('2d')!

    // Get image data from the main canvas and draw it to crop canvas
    const imageData = mainCanvas
      .getContext('2d')!
      .getImageData(minX, minY, width, height)
    ctx.putImageData(imageData, 0, 0)

    const imageDataUrl = cropCanvas.toDataURL('image/png')
    setSelectedImage(imageDataUrl)
    setSelection(null)

    // Clear overlay
    if (overlayCanvasRef.current) {
      overlayCanvasRef.current.getContext('2d')!.clearRect(
        0,
        0,
        overlayCanvasRef.current.width,
        overlayCanvasRef.current.height
      )
    }
  }

  const sendSelectedImage = async () => {
    if (!selectedImage) return

    const userMessage = 'Here is a screenshot from the PDF:'
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        text: userMessage,
        image: selectedImage,
      },
    ])
    setSelectedImage(null)
    setLoading(true)

    try {
      const res = await fetch('http://127.0.0.1:8000/chat?mode=azure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          context: pdfText.slice(0, 4000),
          slideNumber: currentPage,
          image: selectedImage,
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
          slideNumber: currentPage,
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
    if (pdfDocument) {
      renderPage(currentPage)
    }
  }, [pdfDocument, currentPage, zoom])

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

        <div className="pdf-viewer" ref={containerRef}>
          {pdfDocument ? (
            <>
              <div className="canvas-container">
                <div className="canvas-wrapper">
                  <canvas
                    ref={canvasRef}
                    className="pdf-canvas"
                  />
                  <canvas
                    ref={overlayCanvasRef}
                    className="overlay-canvas"
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                  />
                </div>
              </div>
              <div className="pdf-controls">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                >
                  ← Previous
                </button>
                <span className="page-indicator">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next →
                </button>
                <button onClick={() => setZoom(zoom * 1.2)}>Zoom In</button>
                <button onClick={() => setZoom(zoom / 1.2)}>Zoom Out</button>
                <button
                  onClick={() => setZoom(1)}
                  style={{ marginLeft: 'auto' }}
                >
                  Reset Zoom
                </button>
              </div>
              {selection && (
                <div className="selection-controls">
                  <button onClick={extractSelectedArea} className="extract-btn">
                    ✓ Extract Selection
                  </button>
                  <button
                    onClick={() => {
                      setSelection(null)
                      if (overlayCanvasRef.current) {
                        overlayCanvasRef.current.getContext('2d')!.clearRect(
                          0,
                          0,
                          overlayCanvasRef.current.width,
                          overlayCanvasRef.current.height
                        )
                      }
                    }}
                    className="cancel-btn"
                  >
                    ✕ Cancel
                  </button>
                </div>
              )}
              {selectedImage && (
                <div className="preview-section">
                  <div className="preview-header">
                    <h3>Selected Area</h3>
                  </div>
                  <img src={selectedImage} alt="Selected area" className="preview-image" />
                  <div className="preview-actions">
                    <button onClick={sendSelectedImage} className="send-btn">
                      Send to Chat
                    </button>
                    <button
                      onClick={() => setSelectedImage(null)}
                      className="discard-btn"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </>
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
              <div className="message-text">{msg.text}</div>
              {msg.image && (
                <img src={msg.image} alt="Sent" className="message-image" />
              )}
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