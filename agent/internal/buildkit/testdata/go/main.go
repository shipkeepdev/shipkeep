// Built by real_samples_test.go with Railpack and Nixpacks (ADR 0030).
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	greeting, port := os.Getenv("GREETING"), os.Getenv("PORT")
	if greeting == "" {
		greeting = "hello"
	}
	if port == "" {
		port = "3000"
	}
	server := &http.Server{
		Addr:              ":" + port,
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprintf(w, "%s from the shipkeep build test\n", greeting)
		}),
	}
	log.Fatal(server.ListenAndServe())
}
