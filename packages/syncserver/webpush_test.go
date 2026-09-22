package syncserver

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"
)

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := decodeB64(s)
	if err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return b
}

// RFC 8291 Appendix A: the worked example, byte for byte.
func TestEncryptPushMatchesRFC8291Example(t *testing.T) {
	plaintext := mustB64(t, "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24")
	asPriv, err := ecdh.P256().NewPrivateKey(mustB64(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	uaPublic := mustB64(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
	salt := mustB64(t, "DGv6ra1nlYgDCS1FRnbzlw")
	auth := mustB64(t, "BTBZMqHH6r4Tts7J_aSIgg")

	got, err := encryptPushWith(plaintext, uaPublic, auth, asPriv, salt)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy" +
		"27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95b" +
		"Qpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxs" +
		"j_Qulcy4a-fN"
	if b64.EncodeToString(got) != want {
		t.Fatalf("ciphertext mismatch\n got %s\nwant %s", b64.EncodeToString(got), want)
	}

	// And the receiving side recovers the plaintext with the user agent's private key.
	uaPriv, err := ecdh.P256().NewPrivateKey(mustB64(t, "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"))
	if err != nil {
		t.Fatal(err)
	}
	if pt := decryptPush(t, got, uaPriv, auth); string(pt) != string(plaintext) {
		t.Fatalf("round trip = %q", pt)
	}
}

func TestEncryptPushRejectsOversizeAndBadKeys(t *testing.T) {
	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	if _, err := encryptPush(make([]byte, maxPushPayload+1), ua.PublicKey().Bytes(), auth); err == nil {
		t.Fatal("oversize payload accepted")
	}
	if _, err := encryptPush([]byte("x"), ua.PublicKey().Bytes()[:33], auth); err == nil {
		t.Fatal("truncated p256dh accepted")
	}
	if _, err := encryptPush([]byte("x"), ua.PublicKey().Bytes(), auth[:8]); err == nil {
		t.Fatal("short auth secret accepted")
	}
	// The largest payload still fits one 4096-byte message.
	body, err := encryptPush(make([]byte, maxPushPayload), ua.PublicKey().Bytes(), auth)
	if err != nil || len(body) != 4096 {
		t.Fatalf("max payload: len %d, err %v", len(body), err)
	}
}

// decryptPush is the browser's half of RFC 8291, for tests: it opens a message sealed to uaPriv.
func decryptPush(t *testing.T, body []byte, uaPriv *ecdh.PrivateKey, auth []byte) []byte {
	t.Helper()
	if len(body) < 21 {
		t.Fatalf("message too short: %d", len(body))
	}
	salt, rs, idLen := body[:16], binary.BigEndian.Uint32(body[16:20]), int(body[20])
	if rs != pushRecordSize {
		t.Fatalf("record size = %d", rs)
	}
	keyID, ct := body[21:21+idLen], body[21+idLen:]
	asPub, err := ecdh.P256().NewPublicKey(keyID)
	if err != nil {
		t.Fatalf("key id: %v", err)
	}
	secret, err := uaPriv.ECDH(asPub)
	if err != nil {
		t.Fatal(err)
	}
	prkKey, _ := hkdf.Extract(sha256.New, secret, auth)
	ikm, _ := hkdf.Expand(sha256.New, prkKey, "WebPush: info\x00"+string(uaPriv.PublicKey().Bytes())+string(keyID), 32)
	prk, _ := hkdf.Extract(sha256.New, ikm, salt)
	cek, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	i := len(pt) - 1
	for i >= 0 && pt[i] == 0 {
		i--
	}
	if i < 0 || pt[i] != 0x02 {
		t.Fatal("missing last-record delimiter")
	}
	return pt[:i]
}

func TestVAPIDAuthorizationVerifies(t *testing.T) {
	keys, err := newVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	header, err := keys.authorization("https://web.push.apple.com/QGuQyavXutnMp?x=1", "mailto:ops@example.com", now)
	if err != nil {
		t.Fatal(err)
	}
	// vapid t=<header.claims.signature>, k=<public key>
	rest, ok := strings.CutPrefix(header, "vapid t=")
	if !ok {
		t.Fatalf("scheme: %q", header)
	}
	token, k, ok := strings.Cut(rest, ", k=")
	if !ok || k != keys.publicKey() {
		t.Fatalf("k = %q", k)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("jwt parts = %d", len(parts))
	}
	var claims struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(mustB64(t, parts[1]), &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Aud != "https://web.push.apple.com" || claims.Sub != "mailto:ops@example.com" {
		t.Fatalf("claims = %+v", claims)
	}
	if exp := time.Unix(claims.Exp, 0); exp.Sub(now) > 24*time.Hour || !exp.After(now) {
		t.Fatalf("exp %v is not within 24h of %v", exp, now)
	}
	pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), mustB64(t, k))
	if err != nil {
		t.Fatal(err)
	}
	sig := mustB64(t, parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if len(sig) != 64 || !ecdsa.Verify(pub, digest[:], r, s) {
		t.Fatal("signature does not verify against the advertised public key")
	}
}

// One token per push service is reused for up to an hour (Apple asks for no more than hourly
// refreshes), then re-signed; each push service gets its own audience.
func TestVAPIDTokensAreReusedHourly(t *testing.T) {
	keys, _ := newVAPIDKeys()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	first, _ := keys.authorization("https://web.push.apple.com/a", "mailto:ops@example.com", now)
	again, _ := keys.authorization("https://web.push.apple.com/b", "mailto:ops@example.com", now.Add(59*time.Minute))
	if again != first {
		t.Fatal("token re-signed within the hour")
	}
	if other, _ := keys.authorization("https://fcm.googleapis.com/fcm/send/x", "mailto:ops@example.com", now); other == first {
		t.Fatal("two push services share a token")
	}
	if later, _ := keys.authorization("https://web.push.apple.com/a", "mailto:ops@example.com", now.Add(61*time.Minute)); later == first {
		t.Fatal("token not refreshed after an hour")
	}
}

func TestPlaceholderSubject(t *testing.T) {
	for subject, placeholder := range map[string]bool{
		"mailto:no-reply@localhost":       true,
		"mailto:ops@companion.example":    true,
		"https://localhost:8080":          true,
		"https://127.0.0.1":               true,
		"mailto:ops@companion.app":        false,
		"https://cloud.companion.app/api": false,
	} {
		if got := placeholderSubject(subject); got != placeholder {
			t.Errorf("placeholderSubject(%q) = %v, want %v", subject, got, placeholder)
		}
	}
}

func TestParseVAPIDKeys(t *testing.T) {
	a, _ := newVAPIDKeys()
	b, _ := newVAPIDKeys()
	got, err := parseVAPIDKeys(a.publicKey(), a.privateKey())
	if err != nil || got.publicKey() != a.publicKey() {
		t.Fatalf("round trip: %v", err)
	}
	// The public key may be omitted (it's derived) but never mismatched.
	if _, err := parseVAPIDKeys("", a.privateKey()); err != nil {
		t.Fatalf("private only: %v", err)
	}
	if _, err := parseVAPIDKeys(b.publicKey(), a.privateKey()); err == nil {
		t.Fatal("mismatched pair accepted")
	}
	if _, err := parseVAPIDKeys(a.publicKey(), "not-a-key"); err == nil {
		t.Fatal("garbage private key accepted")
	}
}

func TestValidatePushEndpoint(t *testing.T) {
	for endpoint, ok := range map[string]bool{
		"https://fcm.googleapis.com/fcm/send/abc":                  true,
		"https://web.push.apple.com/QGuQyavXutnMp":                 true,
		"https://updates.push.services.mozilla.com/wpush/v2/gAAAA": true,
		"https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB":  true,
		"https://fcm.googleapis.com:443/fcm/send/abc":              true,
		"http://fcm.googleapis.com/fcm/send/abc":                   false, // not https
		"https://fcm.googleapis.com:8443/fcm/send/abc":             false,
		"https://evil.example/fcm.googleapis.com":                  false,
		"https://fcm.googleapis.com.evil.example/x":                false,
		"https://notpush.apple.com.evil.example/x":                 false,
		"https://127.0.0.1/push":                                   false,
		"https://user@web.push.apple.com/x":                        false,
		"javascript:alert(1)":                                      false,
		"":                                                         false,
	} {
		if err := validatePushEndpoint(endpoint); (err == nil) != ok {
			t.Errorf("validatePushEndpoint(%q) = %v, want ok=%v", endpoint, err, ok)
		}
	}
}

func TestPushSubject(t *testing.T) {
	cases := []struct{ configured, public, from, want string }{
		{"mailto:ops@example.com", "https://api.example.com", "a@b.c", "mailto:ops@example.com"},
		{"", "https://api.example.com", "a@b.c", "https://api.example.com"},
		{"", "http://localhost:8080", "Companion <no-reply@example.com>", "mailto:no-reply@example.com"},
		{"", "http://localhost:8080", "", "mailto:no-reply@localhost"},
	}
	for _, c := range cases {
		if got := pushSubject(c.configured, c.public, c.from); got != c.want {
			t.Errorf("pushSubject(%q, %q, %q) = %q, want %q", c.configured, c.public, c.from, got, c.want)
		}
	}
}
