package api

import (
	"github.com/gorilla/mux"
)

func RegisterRoutes(r *mux.Router) {

	r.HandleFunc("/conversations", CreateConversation).Methods("POST")
	r.HandleFunc("/conversations", ListConversations).Methods("GET")
	r.HandleFunc("/conversations/{id}", GetConversation).Methods("GET")
	r.HandleFunc("/conversations/{id}", DeleteConversation).Methods("DELETE")
	r.HandleFunc("/models", ListModels).Methods("GET")
	r.HandleFunc("/config", GetConfig).Methods("GET")
}
