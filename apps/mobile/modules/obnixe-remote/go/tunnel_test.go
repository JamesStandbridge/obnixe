package tunnel

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type echoHandler struct{}

func (echoHandler) Request(id int64, method string, target string, headers string, body string) {
	go Respond(id, http.StatusCreated, `{"content-type":"text/plain","x-target":"`+target+`"}`, method+" "+body+" "+headers)
}

func (echoHandler) Status(string, string, string) {}

func TestRequestsAreAnsweredByTheApp(t *testing.T) {
	_, cancel := context.WithCancel(context.Background())
	running := &tunnel{handler: echoHandler{}, cancel: cancel, pending: map[int64]chan answer{}}
	mu.Lock()
	current = running
	mu.Unlock()
	defer Stop()

	server := httptest.NewServer(running)
	defer server.Close()
	request, err := http.NewRequest(http.MethodPost, server.URL+"/mcp?x=1", strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer abc")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusCreated || response.Header.Get("x-target") != "/mcp?x=1" {
		t.Fatalf("unexpected answer %d %v", response.StatusCode, response.Header)
	}
	if !strings.HasPrefix(string(body), "POST hello ") || !strings.Contains(string(body), `"authorization":"Bearer abc"`) {
		t.Fatalf("unexpected body %q", body)
	}
}
