package buildkit

import (
	"bytes"
	"fmt"
	"slices"

	"github.com/moby/buildkit/client"
	digest "github.com/opencontainers/go-digest"
)

// maxPending bounds what is kept of a step's line that has no newline yet.
const maxPending = 16 << 10

// printer turns BuildKit's progress into plain lines, as `docker build --progress plain` reads:
// `#3 [2/4] RUN npm ci` when a step starts, its output prefixed with its number, `#3 CACHED` or
// `#3 DONE`, and `#3 ERROR: …` when it fails.
type printer struct {
	line     func(string)
	numbers  map[digest.Digest]int
	started  map[digest.Digest]bool
	finished map[digest.Digest]bool
	pending  map[digest.Digest]*bytes.Buffer
}

func newPrinter(line func(string)) *printer {
	return &printer{
		line:     line,
		numbers:  map[digest.Digest]int{},
		started:  map[digest.Digest]bool{},
		finished: map[digest.Digest]bool{},
		pending:  map[digest.Digest]*bytes.Buffer{},
	}
}

func (p *printer) number(vertex digest.Digest) int {
	if n, known := p.numbers[vertex]; known {
		return n
	}
	n := len(p.numbers) + 1
	p.numbers[vertex] = n
	return n
}

func (p *printer) update(status *client.SolveStatus) {
	for _, vertex := range status.Vertexes {
		if vertex == nil {
			continue
		}
		n := p.number(vertex.Digest)
		if vertex.Started != nil && !p.started[vertex.Digest] {
			p.started[vertex.Digest] = true
			p.line(fmt.Sprintf("#%d %s", n, vertex.Name))
		}
		if p.finished[vertex.Digest] {
			continue
		}
		switch {
		case vertex.Error != "":
			p.end(vertex.Digest)
			p.line(fmt.Sprintf("#%d ERROR: %s", n, vertex.Error))
		case vertex.Cached:
			p.end(vertex.Digest)
			p.line(fmt.Sprintf("#%d CACHED", n))
		case vertex.Completed != nil:
			p.end(vertex.Digest)
			p.line(fmt.Sprintf("#%d DONE", n))
		}
	}
	for _, log := range status.Logs {
		if log == nil {
			continue
		}
		buffer := p.pending[log.Vertex]
		if buffer == nil {
			buffer = &bytes.Buffer{}
			p.pending[log.Vertex] = buffer
		}
		buffer.Write(log.Data)
		p.lines(log.Vertex, buffer)
	}
	for _, warning := range status.Warnings {
		if warning != nil {
			p.line(fmt.Sprintf("#%d WARNING: %s", p.number(warning.Vertex), bytes.TrimSpace(warning.Short)))
		}
	}
}

// lines prints the complete lines of a step's output, and cuts a line that never ends.
func (p *printer) lines(vertex digest.Digest, buffer *bytes.Buffer) {
	n := p.number(vertex)
	for {
		index := bytes.IndexByte(buffer.Bytes(), '\n')
		if index < 0 {
			break
		}
		text := bytes.TrimRight(buffer.Next(index+1), "\r\n")
		p.line(fmt.Sprintf("#%d %s", n, text))
	}
	if buffer.Len() > maxPending {
		p.line(fmt.Sprintf("#%d %s", n, buffer.Next(maxPending)))
	}
}

// end prints what is left of a step's output before its last line.
func (p *printer) end(vertex digest.Digest) {
	p.finished[vertex] = true
	if buffer := p.pending[vertex]; buffer != nil && buffer.Len() > 0 {
		p.line(fmt.Sprintf("#%d %s", p.number(vertex), bytes.TrimRight(buffer.Bytes(), "\r\n")))
		buffer.Reset()
	}
}

// flush prints what is left of every step's output, in step order.
func (p *printer) flush() {
	vertices := make([]digest.Digest, 0, len(p.pending))
	for vertex, buffer := range p.pending {
		if buffer.Len() > 0 {
			vertices = append(vertices, vertex)
		}
	}
	slices.SortFunc(vertices, func(a, b digest.Digest) int { return p.numbers[a] - p.numbers[b] })
	for _, vertex := range vertices {
		buffer := p.pending[vertex]
		p.line(fmt.Sprintf("#%d %s", p.number(vertex), bytes.TrimRight(buffer.Bytes(), "\r\n")))
		buffer.Reset()
	}
}
