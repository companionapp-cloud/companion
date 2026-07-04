package main

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

const timeFormat = time.RFC3339Nano

type authRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type authResponse struct {
	Token  string `json:"token"`
	UserID string `json:"userId"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	if email == "" || len(req.Password) < 6 {
		writeErr(w, http.StatusBadRequest, "email and a 6+ character password are required")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash failed")
		return
	}
	id, _ := uuid.NewV7()
	uid := id.String()
	now := s.clock.Now().UTC().Format(timeFormat)

	if _, err := s.exec(
		`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?);`,
		uid, email, string(hash), now); err != nil {
		writeErr(w, http.StatusConflict, "email already registered")
		return
	}
	s.exec(`INSERT INTO user_seq (user_id, seq) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING;`, uid)

	token, err := s.newSession(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "session failed")
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: token, UserID: uid})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))

	var uid, hash string
	err := s.queryRow(`SELECT id, password_hash FROM users WHERE email = ?;`, email).Scan(&uid, &hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		writeErr(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	token, err := s.newSession(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "session failed")
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: token, UserID: uid})
}

func (s *Server) newSession(userID string) (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	_, err := s.exec(
		`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?);`,
		token, userID, s.clock.Now().UTC().Format(timeFormat))
	if err != nil {
		return "", err
	}
	return token, nil
}
