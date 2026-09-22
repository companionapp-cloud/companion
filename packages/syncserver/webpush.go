package syncserver

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Web Push (RFC 8030) on the standard library: VAPID application-server identification (RFC 8292)
// and aes128gcm message encryption (RFC 8291 over RFC 8188). A push service (Apple, Google,
// Mozilla, Microsoft) only ever relays ciphertext; only the subscribed browser, which holds the
// subscription's private key, can read a message.

// b64 is the unpadded base64url encoding every Web Push key and JWT segment uses.
var b64 = base64.RawURLEncoding

// decodeB64 reads a base64url value leniently: browsers and tooling differ on padding, and some
// hand out the standard alphabet.
func decodeB64(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	return b64.DecodeString(s)
}

// vapidKeys is the server's application-server key pair: an ECDSA P-256 key whose public half every
// browser subscription is bound to (applicationServerKey), and whose private half signs the JWT each
// push carries. Rotating it orphans every existing subscription, so it is generated once and kept.
type vapidKeys struct {
	priv *ecdsa.PrivateKey

	// Signed tokens, reused per push service (audience) for vapidTokenReuse: Apple asks that a
	// token be refreshed at most hourly rather than minted for every message.
	mu     sync.Mutex
	tokens map[string]vapidToken
}

type vapidToken struct {
	header   string
	issuedAt time.Time
}

func newVAPIDKeys() (*vapidKeys, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return &vapidKeys{priv: priv}, nil
}

// parseVAPIDKeys reads a key pair in the encoding the web-push tooling uses (and prints from
// `npx web-push generate-vapid-keys`): the private key as its raw 32-byte scalar and the public key
// as the 65-byte uncompressed point, both base64url. The public key must match the private one, so
// a mismatched pair fails at boot rather than at the first push.
func parseVAPIDKeys(publicKey, privateKey string) (*vapidKeys, error) {
	rawPriv, err := decodeB64(privateKey)
	if err != nil {
		return nil, fmt.Errorf("private key: %w", err)
	}
	priv, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), rawPriv)
	if err != nil {
		return nil, fmt.Errorf("private key: %w", err)
	}
	k := &vapidKeys{priv: priv}
	if strings.TrimSpace(publicKey) != "" {
		rawPub, err := decodeB64(publicKey)
		if err != nil {
			return nil, fmt.Errorf("public key: %w", err)
		}
		if want, _ := priv.PublicKey.Bytes(); string(want) != string(rawPub) {
			return nil, errors.New("public key does not match the private key")
		}
	}
	return k, nil
}

// publicKey is the applicationServerKey browsers subscribe with.
func (k *vapidKeys) publicKey() string {
	raw, _ := k.priv.PublicKey.Bytes()
	return b64.EncodeToString(raw)
}

func (k *vapidKeys) privateKey() string {
	raw, _ := k.priv.Bytes()
	return b64.EncodeToString(raw)
}

// vapidTokenLifetime is how long a signed VAPID token is valid. RFC 8292 caps it at 24 hours (and
// Apple rejects anything further out); half that leaves room for clock skew against the push service.
const vapidTokenLifetime = 12 * time.Hour

// vapidTokenReuse is how long one signed token serves a push service before a fresh one is signed.
const vapidTokenReuse = time.Hour

// authorization returns the RFC 8292 Authorization header for a push to endpoint: an ES256 JWT
// whose audience is the push service's origin and whose subject is the operator contact, plus the
// public key it verifies against. One token per push service is reused for vapidTokenReuse.
func (k *vapidKeys) authorization(endpoint, subject string, now time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("invalid push endpoint")
	}
	aud := u.Scheme + "://" + u.Host
	k.mu.Lock()
	defer k.mu.Unlock()
	if t, ok := k.tokens[aud+" "+subject]; ok && now.Sub(t.issuedAt) >= 0 && now.Sub(t.issuedAt) < vapidTokenReuse {
		return t.header, nil
	}
	header, err := k.sign(aud, subject, now)
	if err != nil {
		return "", err
	}
	if k.tokens == nil {
		k.tokens = map[string]vapidToken{}
	}
	k.tokens[aud+" "+subject] = vapidToken{header: header, issuedAt: now}
	return header, nil
}

// sign mints the Authorization header for one audience.
func (k *vapidKeys) sign(aud, subject string, now time.Time) (string, error) {
	header := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, err := json.Marshal(struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}{aud, now.Add(vapidTokenLifetime).Unix(), subject})
	if err != nil {
		return "", err
	}
	signingInput := header + "." + b64.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, k.priv, digest[:])
	if err != nil {
		return "", err
	}
	// JWS wants the raw r||s pair, each left-padded to the curve size — not ASN.1.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + signingInput + "." + b64.EncodeToString(sig) + ", k=" + k.publicKey(), nil
}

// pushRecordSize is the record size declared for the single aes128gcm record a push carries (RFC
// 8188 §2). Push services cap a message at 4096 bytes, so one record always holds it.
const pushRecordSize = 4096

// maxPushPayload is the largest plaintext that fits a 4096-byte push message after the header (16
// salt + 4 record size + 1 key-id length + 65 key id), the 16-byte GCM tag, and the 1-byte padding
// delimiter.
const maxPushPayload = 4096 - 86 - 16 - 1

// encryptPush seals plaintext for one subscription (RFC 8291) — the subscription's P-256 public key
// (p256dh) and 16-byte auth secret — with a fresh ephemeral key and salt, so no two messages share a
// content key.
func encryptPush(plaintext, uaPublic, authSecret []byte) ([]byte, error) {
	asPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	return encryptPushWith(plaintext, uaPublic, authSecret, asPriv, salt)
}

// encryptPushWith is encryptPush with the ephemeral key and salt supplied: the deterministic core,
// checked against RFC 8291's worked example.
func encryptPushWith(plaintext, uaPublic, authSecret []byte, asPriv *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(plaintext) > maxPushPayload {
		return nil, fmt.Errorf("push payload is %d bytes; the limit is %d", len(plaintext), maxPushPayload)
	}
	if len(authSecret) != 16 {
		return nil, errors.New("push auth secret must be 16 bytes")
	}
	if len(salt) != 16 {
		return nil, errors.New("push salt must be 16 bytes")
	}
	uaKey, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("push p256dh key: %w", err)
	}
	secret, err := asPriv.ECDH(uaKey)
	if err != nil {
		return nil, err
	}
	asPublic := asPriv.PublicKey().Bytes()

	// RFC 8291 §3.3–3.4: mix the auth secret into the ECDH secret, then derive the content key and
	// nonce from that and the salt (RFC 8188 §2.2–2.3).
	prkKey, err := hkdf.Extract(sha256.New, secret, authSecret)
	if err != nil {
		return nil, err
	}
	ikm, err := hkdf.Expand(sha256.New, prkKey, "WebPush: info\x00"+string(uaPublic)+string(asPublic), 32)
	if err != nil {
		return nil, err
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	// One final record: the plaintext, then the 0x02 last-record delimiter, unpadded.
	record := make([]byte, 0, len(plaintext)+1)
	record = append(append(record, plaintext...), 0x02)

	out := make([]byte, 0, 21+len(asPublic)+len(record)+gcm.Overhead())
	out = append(out, salt...)
	out = binary.BigEndian.AppendUint32(out, pushRecordSize)
	out = append(out, byte(len(asPublic)))
	out = append(out, asPublic...)
	return gcm.Seal(out, nonce, record, nil), nil
}

// pushClient delivers messages to push services. Redirects are refused: a push service answers
// directly, and following one would let a subscription steer the server somewhere else.
var pushClient = &http.Client{
	Timeout: 15 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// pushOutcome classifies a push service's answer to one message.
type pushOutcome int

const (
	pushDelivered pushOutcome = iota // 2xx: accepted for delivery
	pushGone                         // 404/410: the subscription no longer exists; forget it
	pushFailed                       // anything else; the error says why
)

// pushMessage is one notification on its way to a push service.
type pushMessage struct {
	payload []byte
	// ttl is how long the push service may hold the message for an offline device (RFC 8030 §5.2).
	ttl time.Duration
	// urgency is RFC 8030 §5.3's hint: "very-low", "low", "normal" or "high".
	urgency string
}

// sendPush encrypts msg for sub and posts it to the subscription's push service, reporting what
// became of it. The error carries the push service's status and reason for the log.
func (s *Server) sendPush(ctx context.Context, sub pushSubscription, msg pushMessage) (pushOutcome, error) {
	uaPublic, err := decodeB64(sub.p256dh)
	if err != nil {
		return pushGone, fmt.Errorf("stored p256dh key: %w", err)
	}
	authSecret, err := decodeB64(sub.auth)
	if err != nil {
		return pushGone, fmt.Errorf("stored auth secret: %w", err)
	}
	body, err := encryptPush(msg.payload, uaPublic, authSecret)
	if err != nil {
		return pushFailed, err
	}
	authz, err := s.vapid.authorization(sub.endpoint, s.vapidSubject, s.clock.Now())
	if err != nil {
		return pushFailed, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.endpoint, bytes.NewReader(body))
	if err != nil {
		return pushFailed, err
	}
	req.Header.Set("Authorization", authz)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", strconv.Itoa(int(msg.ttl/time.Second)))
	if msg.urgency != "" {
		req.Header.Set("Urgency", msg.urgency)
	}
	resp, err := pushClient.Do(req)
	if err != nil {
		return pushFailed, err
	}
	defer resp.Body.Close()
	// Push services explain a rejection in a short body (Apple: {"reason":"BadJwtToken"}).
	reason, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return pushDelivered, nil
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return pushGone, fmt.Errorf("push service: %d %s", resp.StatusCode, strings.TrimSpace(string(reason)))
	default:
		return pushFailed, fmt.Errorf("push service: %d %s", resp.StatusCode, strings.TrimSpace(string(reason)))
	}
}
