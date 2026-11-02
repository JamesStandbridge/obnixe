// Package tunnel publishes the phone on the ngrok dev domain of the user's account and hands every HTTP request to the
// app, which answers it through Respond. Nothing is served by this package itself.
package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.ngrok.com/ngrok/v2"
)

// Handler receives the requests and the tunnel states. Methods are called from Go threads, never concurrently for Status.
type Handler interface {
	// Request carries one HTTP request; headers is a JSON object of lowercase names to values joined by ", ".
	Request(id int64, method string, target string, headers string, body string)
	// Status is "connecting", "online" (with url), "reconnecting", "error" (with message) or "stopped".
	Status(state string, url string, message string)
}

const (
	maxBodyBytes  = 1 << 20
	answerTimeout = 30 * time.Second
	clientVersion = "1.0.0"
)

type answer struct {
	status  int
	headers map[string]string
	body    string
}

type tunnel struct {
	handler Handler
	cancel  context.CancelFunc
	nextID  atomic.Int64
	mu      sync.Mutex
	pending map[int64]chan answer
	url     string
	status  sync.Mutex
}

var (
	mu      sync.Mutex
	current *tunnel
)

// Start replaces any running tunnel with one authenticated by authtoken; its states arrive through handler.Status.
func Start(authtoken string, handler Handler) {
	Stop()
	ctx, cancel := context.WithCancel(context.Background())
	t := &tunnel{handler: handler, cancel: cancel, pending: map[int64]chan answer{}}
	mu.Lock()
	current = t
	mu.Unlock()
	go t.run(ctx, authtoken)
}

// Stop closes the running tunnel, if any, and fails the requests still waiting for an answer.
func Stop() {
	mu.Lock()
	t := current
	current = nil
	mu.Unlock()
	if t != nil {
		t.cancel()
		t.status.Lock()
		t.handler.Status("stopped", "", "")
		t.status.Unlock()
	}
}

// Respond answers request id; headers is a JSON object of names to values. Unknown or late ids are ignored.
func Respond(id int64, status int, headers string, body string) {
	mu.Lock()
	t := current
	mu.Unlock()
	if t == nil {
		return
	}
	parsed := map[string]string{}
	if err := json.Unmarshal([]byte(headers), &parsed); err != nil {
		status, parsed, body = http.StatusInternalServerError, map[string]string{"content-type": "text/plain; charset=utf-8"}, "Invalid response headers"
	}
	t.mu.Lock()
	waiting, found := t.pending[id]
	delete(t.pending, id)
	t.mu.Unlock()
	if found {
		waiting <- answer{status: status, headers: parsed, body: body}
	}
}

// setStatus reports a state of t unless t was stopped or replaced, which already reported "stopped".
func (t *tunnel) setStatus(state string, url string, message string) {
	t.status.Lock()
	defer t.status.Unlock()
	mu.Lock()
	live := current == t
	mu.Unlock()
	if live {
		t.handler.Status(state, url, message)
	}
}

func (t *tunnel) run(ctx context.Context, authtoken string) {
	t.setStatus("connecting", "", "")
	agent, err := ngrok.NewAgent(
		ngrok.WithAuthtoken(authtoken),
		ngrok.WithClientInfo("obnixe", clientVersion),
		ngrok.WithEventHandler(func(event ngrok.Event) { t.onEvent(ctx, event) }),
	)
	if err != nil {
		t.setStatus("error", "", describe(err))
		return
	}
	listener, err := agent.Listen(ctx, ngrok.WithDescription("Obnixe"))
	if err != nil {
		_ = agent.Disconnect()
		if ctx.Err() == nil {
			t.setStatus("error", "", describe(err))
		}
		return
	}
	t.mu.Lock()
	t.url = listener.URL().String()
	t.mu.Unlock()
	t.setStatus("online", listener.URL().String(), "")
	server := &http.Server{Handler: t, ReadHeaderTimeout: 15 * time.Second}
	go func() {
		<-ctx.Done()
		_ = server.Close()
		_ = listener.Close()
		_ = agent.Disconnect()
	}()
	err = server.Serve(listener)
	if ctx.Err() == nil {
		t.setStatus("error", "", describe(err))
		t.cancel()
	}
}

func (t *tunnel) onEvent(ctx context.Context, event ngrok.Event) {
	if ctx.Err() != nil {
		return
	}
	switch typed := event.(type) {
	case *ngrok.EventAgentDisconnected:
		message := ""
		if typed.Error != nil {
			message = describe(typed.Error)
		}
		t.setStatus("reconnecting", "", message)
	case *ngrok.EventAgentConnectSucceeded:
		t.mu.Lock()
		url := t.url
		t.mu.Unlock()
		if url != "" {
			t.setStatus("online", url, "")
		}
	}
}

func describe(err error) string {
	var ngrokErr ngrok.Error
	if errors.As(err, &ngrokErr) && ngrokErr.Code() != "" {
		return ngrokErr.Code() + ": " + ngrokErr.Error()
	}
	return err.Error()
}

func (t *tunnel) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxBodyBytes))
	if err != nil {
		http.Error(writer, "Request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	headers := map[string]string{}
	for name, values := range request.Header {
		headers[strings.ToLower(name)] = strings.Join(values, ", ")
	}
	encoded, err := json.Marshal(headers)
	if err != nil {
		http.Error(writer, "Unreadable request headers", http.StatusBadRequest)
		return
	}
	id := t.nextID.Add(1)
	waiting := make(chan answer, 1)
	t.mu.Lock()
	t.pending[id] = waiting
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.pending, id)
		t.mu.Unlock()
	}()
	t.handler.Request(id, request.Method, request.URL.RequestURI(), string(encoded), string(body))
	timer := time.NewTimer(answerTimeout)
	defer timer.Stop()
	select {
	case reply := <-waiting:
		for name, value := range reply.headers {
			writer.Header().Set(name, value)
		}
		writer.WriteHeader(reply.status)
		_, _ = io.WriteString(writer, reply.body)
	case <-timer.C:
		http.Error(writer, "Obnixe did not answer in time; open the app on the phone", http.StatusGatewayTimeout)
	case <-request.Context().Done():
	}
}
