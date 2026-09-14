package ollama

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestModelSuccess(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != modelListPath {
			t.Fatalf("expected path %q, got %q", modelListPath, r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")

		fmt.Fprintln(w, `{
					"models": [
						{
							"name": "testModel",
							"model": "test",
							"details": {"parameter_size": "small"}
						}
					]
				}`)
	}))

	defer ts.Close()

	client := NewClient(ts.URL)

	models, err := client.ListModels()

	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(models) != 1 {
		t.Fatalf("expected 1 model, got %d", len(models))
	}
	if models[0].Name != "testModel" {
		t.Errorf("expected model name to be 'testModel', got '%s'", models[0].Name)
	}
	if models[0].Details.ParameterSize != "small" {
		t.Errorf("expected parameter size to be 'small', got '%s'", models[0].Details.ParameterSize)
	}
}

func TestListModelsDecodeError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		fmt.Fprintln(w, `invalid json`)
	}))

	defer ts.Close()

	client := NewClient(ts.URL)
	_, err := client.ListModels()
	if err == nil {
		t.Fatal("expected an error decoding JSON, got nil")
	}

	if !strings.Contains(err.Error(), "failed to decode response") {
		t.Errorf("unexpected error message: %v", err)
	}
}
