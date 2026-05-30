/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, useCallback } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
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

const looksLikeMath = (text: string): boolean => {
  const trimmed = text.trim()

  if (!trimmed) return false

  if (/\\[a-zA-Z]+/.test(trimmed)) return true
  if (/[_^]/.test(trimmed)) return true
  if (/[=<>]/.test(trimmed) && /[A-Za-z]/.test(trimmed)) return true

  return false
}

const normalizeMathDelimiters = (text: string): string =>
  text
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_, math: string) => `$$${math.trim()}$$`)
    .replace(/\\\(((?:.|\n)*?)\\\)/g, (_, math: string) => `$${math.trim()}$`)
    .replace(/(^|[\s:])\((.+?)\)(?=$|[\s.,;:!?])/g, (match, prefix: string, inner: string) => {
      if (!looksLikeMath(inner)) {
        return match
      }

      return `${prefix}$${inner.trim()}$`
    })

const prepareMessageText = (text: string): string => normalizeMathDelimiters(text)

/** pdf.js viewport scale; 2 matches “zoom in twice” vs the library’s nominal page size */
const DEFAULT_PDF_RENDER_SCALE = 2

/** Must stay within backend `MAX_CONTEXT_LENGTH` so the repeated current page is not truncated away */
const MAX_CONTEXT_CHARS = 4000

const wrapTextForPDF = (
  text: string,
  maxWidth: number,
  font: { widthOfTextAtSize: (text: string, size: number) => number },
  fontSize: number
): string[] => {
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n')
  const lines: string[] = []

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim()

    if (!trimmedParagraph) {
      lines.push('')
      continue
    }

    const words = trimmedParagraph.split(/\s+/)
    let currentLine = ''

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word

      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        currentLine = candidate
        continue
      }

      if (currentLine) {
        lines.push(currentLine)
      }

      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
        currentLine = word
        continue
      }

      let chunk = ''
      for (const char of word) {
        const chunkCandidate = chunk + char
        if (font.widthOfTextAtSize(chunkCandidate, fontSize) > maxWidth && chunk) {
          lines.push(chunk)
          chunk = char
        } else {
          chunk = chunkCandidate
        }
      }

      currentLine = chunk
    }

    if (currentLine) {
      lines.push(currentLine)
    }
  }

  while (lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines
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
  const [pdfPages, setPdfPages] = useState<string[]>([])
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [zoom, setZoom] = useState(DEFAULT_PDF_RENDER_SCALE)
  const [isSelecting, setIsSelecting] = useState(false)
  const [selection, setSelection] = useState<SelectionRect | null>(null)
  const [selectedImage, setSelectedImage] = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isRenderingRef = useRef(false)

  const pageCount = Math.max(totalPages, 1)

  /** Full PDF text, then the active page’s text again at the end (fits `MAX_CONTEXT_CHARS`). */
  const buildApiContext = () => {
    const n = Math.max(pdfPages.length, totalPages, 1)
    const safePage = Math.min(Math.max(currentPage, 1), n)
    const idx = safePage - 1
    let pageRepeat = (pdfPages[idx] ?? '').trim()
    const fullDoc = (pdfPages.length > 0 ? pdfPages.join('\n\n') : pdfText).trim()

    const prefix = `[Full PDF — ${n} page(s)${pdfName ? ` — ${pdfName}` : ''}]\n\n`
    const suffixIntro =
      `\n\n---\n[Currently viewing page ${safePage} of ${n} — that page’s text is repeated below]\n\n`

    const makeSuffix = (body: string) => suffixIntro + body

    let suffix = makeSuffix(pageRepeat)
    if (prefix.length + suffix.length > MAX_CONTEXT_CHARS) {
      const room = Math.max(
        0,
        MAX_CONTEXT_CHARS - prefix.length - suffixIntro.length - 1
      )
      pageRepeat = pageRepeat.slice(0, room) + (room > 0 ? '…' : '')
      suffix = makeSuffix(pageRepeat)
    }

    let budget = MAX_CONTEXT_CHARS - prefix.length - suffix.length
    if (budget <= 0) {
      return (prefix + suffix).slice(0, MAX_CONTEXT_CHARS)
    }

    let doc = fullDoc
    if (doc.length > budget) {
      doc =
        doc.slice(0, budget) +
        '\n[…document trimmed for API length limit; end of context repeats the current page…]'
    }

    const out = prefix + doc + suffix
    return out.length > MAX_CONTEXT_CHARS ? out.slice(0, MAX_CONTEXT_CHARS) : out
  }

  const pointerToOverlayCanvas = (
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number
  ) => {
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / rect.width || 1
    const sy = canvas.height / rect.height || 1
    return {
      x: (clientX - rect.left) * sx,
      y: (clientY - rect.top) * sy,
    }
  }

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
    setZoom(DEFAULT_PDF_RENDER_SCALE)
    setSelectedImage(null)
    setSelection(null)

    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    setPdfDocument(pdf)
    setTotalPages(pdf.numPages)

    const pages: string[] = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      pages.push(
        content.items.map((item: any) => ('str' in item ? item.str : '')).join(' ')
      )
    }
    setPdfPages(pages)
    setPdfText(pages.join('\n'))
    setMessages([
      {
        role: 'assistant',
        text: `"${file.name}" loaded (${pdf.numPages} pages). What do you want to know?`,
      },
    ])
  }

  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdfDocument || !canvasRef.current) return

    if (isRenderingRef.current) return
    isRenderingRef.current = true

    try {
      const page = await pdfDocument.getPage(pageNum)
      const viewport = page.getViewport({ scale: zoom })

      const canvas = canvasRef.current
      canvas.width = viewport.width
      canvas.height = viewport.height

      await page.render({
        canvasContext: canvas.getContext('2d')!,
        canvas,
        viewport,
      }).promise

      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = viewport.width
        overlayCanvasRef.current.height = viewport.height
      }
    } catch (error) {
      console.error('Error rendering page:', error)
    } finally {
      isRenderingRef.current = false
    }
  }, [pdfDocument, zoom])

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return

    const { x, y } = pointerToOverlayCanvas(canvas, e.clientX, e.clientY)

    setSelection({ startX: x, startY: y, endX: x, endY: y })
    setIsSelecting(true)
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isSelecting || !selection) return

    const canvas = overlayCanvasRef.current
    if (!canvas) return

    const { x, y } = pointerToOverlayCanvas(canvas, e.clientX, e.clientY)

    const newSelection = {
      ...selection,
      endX: Math.max(0, Math.min(x, canvas.width)),
      endY: Math.max(0, Math.min(y, canvas.height)),
    }
    setSelection(newSelection)

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

    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = width
    cropCanvas.height = height
    const ctx = cropCanvas.getContext('2d')!

    const imageData = mainCanvas.getContext('2d')!.getImageData(minX, minY, width, height)
    ctx.putImageData(imageData, 0, 0)

    const imageDataUrl = cropCanvas.toDataURL('image/png')
    setSelectedImage(imageDataUrl)
    setSelection(null)

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
          context: buildApiContext(),
          slideNumber: currentPage,
          image: selectedImage,
        }),
      })

      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json()

      if (data.error) throw new Error(data.details || data.error)

      setMessages((prev) => [...prev, { role: 'assistant', text: prepareMessageText(data.response) }])
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
      const ctx = buildApiContext()
      const res = await fetch('http://127.0.0.1:8000/chat?mode=azure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          context: ctx,
          slideNumber: currentPage,
        }),
      })

      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json()

      if (data.error) throw new Error(data.details || data.error)

      setMessages((prev) => [...prev, { role: 'assistant', text: prepareMessageText(data.response) }])
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

  const sanitizeTextForPDF = (text: string): string => {
    const normalizedText = prepareMessageText(text)
    const sanitized = normalizedText
      .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
      .replace(/\$([\s\S]*?)\$/g, '$1')
      .replace(/\\text\{([^}]*)\}/g, '$1')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      // eslint-disable-next-line no-useless-escape
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
      .replace(/^[\s]*[-*+]\s/gm, '- ')

    return sanitized
      .replace(/\t/g, '  ')
      .replace(/[\u0080-\uffff]/g, (char) => {
        const replacements: { [key: string]: string } = {
          '→': '->',
          '⇒': '=>',
          '←': '<-',
          '⇐': '<=',
          '≥': '>=',
          '≤': '<=',
          '≠': '!=',
          '≈': '~=',
          '±': '+/-',
          '×': 'x',
          '·': '*',
          '∞': 'infinity',
          '✓': 'v',
          '✕': 'x',
          '…': '...',
          '\u201C': '"',
          '\u201D': '"',
          '\u2018': "'",
          '\u2019': "'",
          '\u2014': '-',
          '\u2013': '-',
          '\u2022': '*',
          '\u2122': '(TM)',
          '\u00A9': '(C)',
          '\u00AE': '(R)',
        }
        return replacements[char] || '?'
      })
  }

  const exportChatAsPDF = async () => {
    if (!pdfUrl || messages.length === 0) {
      alert('Please upload a PDF and have a chat first.')
      return
    }

    try {
      const pdfResponse = await fetch(pdfUrl)
      const pdfArrayBuffer = await pdfResponse.arrayBuffer()

      const pdfDoc = await PDFDocument.load(pdfArrayBuffer)
      const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica)

      const pageWidth = 595
      const pageHeight = 842
      const margin = 40
      const lineHeight = 16
      const bodyFontSize = 10
      const labelFontSize = 11
      const textX = margin + 15
      const textWidth = pageWidth - textX - margin

      let currentPage = pdfDoc.addPage([pageWidth, pageHeight])

      const addChatPage = () => {
        currentPage = pdfDoc.addPage([pageWidth, pageHeight])
        return pageHeight - margin
      }

      const ensureSpace = (yPosition: number, requiredHeight: number) => {
        if (yPosition - requiredHeight < margin) {
          return addChatPage()
        }

        return yPosition
      }

      currentPage.drawText('Chat History with Crambot', {
        x: margin,
        y: pageHeight - margin,
        size: 16,
        color: rgb(0, 0, 0),
        font: regularFont,
      })

      currentPage.drawText(`PDF: ${pdfName}`, {
        x: margin,
        y: pageHeight - margin - 25,
        size: 10,
        color: rgb(0.4, 0.4, 0.4),
        font: regularFont,
      })

      let yPosition = pageHeight - margin - 50

      for (const message of messages) {
        if (message.text === 'Hi! Upload a PDF and ask me anything about it.') {
          continue
        }

        const author = message.role === 'user' ? 'You' : 'Assistant'
        const sanitizedText = sanitizeTextForPDF(message.text)
        const lines = wrapTextForPDF(sanitizedText, textWidth, regularFont, bodyFontSize)
        const label = `${author}:`
        const labelColor = message.role === 'user' ? rgb(0, 0.3, 0.8) : rgb(0.2, 0.5, 0.2)

        yPosition = ensureSpace(yPosition, lineHeight * 2)
        currentPage.drawText(label, {
          x: margin,
          y: yPosition,
          size: labelFontSize,
          color: labelColor,
          font: regularFont,
        })

        yPosition -= 16

        for (const line of lines) {
          yPosition = ensureSpace(yPosition, lineHeight)

          if (!line) {
            yPosition -= lineHeight
            continue
          }

          currentPage.drawText(line, {
            x: textX,
            y: yPosition,
            size: bodyFontSize,
            color: rgb(0.1, 0.1, 0.1),
            font: regularFont,
          })
          yPosition -= lineHeight
        }

        yPosition -= 8
      }

      const pdfBytes = await pdfDoc.save()
      const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${pdfName.replace('.pdf', '')}_with_chat.pdf`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Error exporting PDF:', error)
      alert('Failed to export PDF. Check console for details.')
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (pdfDocument) {
      renderPage(currentPage)
    }
  }, [pdfDocument, currentPage, zoom, renderPage])

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    }
  }, [pdfUrl])

  return (
    <div className="app-shell">
      <section className="pdf-pane">
        <header className="pane-header pdf-pane-header">
          <div className="pdf-pane-header-row">
            <h1>Crambot</h1>
            <label className="upload-label">
              <span className="upload-label-text">
                {pdfName ? pdfName : 'Upload PDF'}
              </span>
              <input type="file" accept="application/pdf" onChange={handleUpload} />
            </label>
          </div>
        </header>

        <div className="pdf-viewer" ref={containerRef}>
          {pdfDocument ? (
            <>
              <div className="pdf-toolbar" role="toolbar" aria-label="PDF controls">
                <div className="pdf-toolbar-group">
                  <button
                    type="button"
                    className="pdf-toolbar-btn"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous page"
                  >
                    ‹
                  </button>
                  <label className="pdf-page-field">
                    <span className="visually-hidden">Page</span>
                    <input
                      type="number"
                      min={1}
                      max={pageCount}
                      value={currentPage}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        if (Number.isNaN(n)) return
                        setCurrentPage(Math.min(pageCount, Math.max(1, n)))
                      }}
                    />
                    <span className="pdf-page-of">/ {pageCount}</span>
                  </label>
                  <button
                    type="button"
                    className="pdf-toolbar-btn"
                    disabled={currentPage >= pageCount}
                    onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}
                    aria-label="Next page"
                  >
                    ›
                  </button>
                </div>
                <div className="pdf-toolbar-divider" aria-hidden />
                <div className="pdf-toolbar-group pdf-toolbar-zoom-group">
                  <button
                    type="button"
                    className="pdf-toolbar-text-btn"
                    onClick={() => setZoom((z) => Math.max(0.5, z / 1.2))}
                  >
                    −
                  </button>
                  <span className="pdf-zoom-indicator" title="Render scale">
                    {zoom >= 10 ? zoom.toFixed(0) : zoom.toFixed(1)}×
                  </span>
                  <button
                    type="button"
                    className="pdf-toolbar-text-btn"
                    onClick={() => setZoom((z) => z * 1.2)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="pdf-toolbar-reset-btn"
                    onClick={() => setZoom(DEFAULT_PDF_RENDER_SCALE)}
                  >
                    Default
                  </button>
                </div>
              </div>
              <div className="canvas-container">
                <div className="canvas-wrapper">
                  <canvas ref={canvasRef} className="pdf-canvas" />
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
                    <button onClick={() => setSelectedImage(null)} className="discard-btn">
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
        <header className="pane-header chat-pane-header">
          <div className="chat-pane-header-row">
            <h2>Crambot Chat</h2>
            <button
              type="button"
              className="pill-control-btn"
              onClick={exportChatAsPDF}
              disabled={!pdfUrl || messages.length === 0}
              title="Export chat as PDF with comments"
            >
              Export chat as PDF
            </button>
          </div>
        </header>

        <div className="chat-messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`chat-message ${msg.role}`}>
              <div className="message-text">
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {prepareMessageText(msg.text)}
                </ReactMarkdown>
              </div>
              {msg.image && <img src={msg.image} alt="Sent" className="message-image" />}
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
          <button type="button" onClick={sendMessage} disabled={loading || !input.trim()}>
            Send
          </button>
        </div>
      </aside>
    </div>
  )
}

export default App
