package syncserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithy "github.com/aws/smithy-go"
)

// Document bytes live in object storage, addressed by {user_id}/{sha256}, and reach the
// server only through the streaming blob endpoints (PLAN §6.9). BlobBackend is the seam
// over the actual store, so the same handlers run against any S3-compatible provider (AWS
// S3, Cloudflare R2, Backblaze B2, MinIO) in production and a local filesystem or in-memory
// store in dev and tests — mirroring how the SQL layer abstracts Postgres vs SQLite.
type BlobBackend interface {
	// Put stores size bytes read from r under key, overwriting any existing object. Because
	// keys are content addresses, an overwrite is byte-identical — idempotent by design.
	Put(ctx context.Context, key string, r io.Reader, size int64) error
	// Get opens the object at key, or errBlobNotFound if absent.
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// Delete removes the object at key (a no-op if already absent).
	Delete(ctx context.Context, key string) error
}

// errBlobNotFound is the backend-agnostic "no such object" signal, mapped to 404.
var errBlobNotFound = errors.New("blob not found")

// newBlobBackend selects the object store from the environment (PLAN §6.9): an
// S3-compatible bucket when BLOB_S3_BUCKET is set, else a filesystem dir when BLOB_FS_DIR
// is set, else an in-memory store (the zero-config default used by tests and quick local
// runs). Only the S3 path can fail construction, and only when explicitly requested.
func newBlobBackend() (BlobBackend, error) {
	if os.Getenv("BLOB_S3_BUCKET") != "" {
		return newS3Backend()
	}
	if dir := os.Getenv("BLOB_FS_DIR"); dir != "" {
		return newFSBackend(dir)
	}
	return newMemBackend(), nil
}

// maxBlobSizeFromEnv reads BLOB_MAX_SIZE (bytes), defaulting to 100 MB (PLAN §6.9).
func maxBlobSizeFromEnv() int64 {
	const def int64 = 100 << 20
	if v := os.Getenv("BLOB_MAX_SIZE"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// ---- in-memory backend (default for tests / zero-config dev) --------------

type memBlobBackend struct {
	mu    sync.RWMutex
	blobs map[string][]byte
}

func newMemBackend() *memBlobBackend { return &memBlobBackend{blobs: map[string][]byte{}} }

func (m *memBlobBackend) Put(_ context.Context, key string, r io.Reader, _ int64) error {
	buf, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.blobs[key] = buf
	m.mu.Unlock()
	return nil
}

func (m *memBlobBackend) Get(_ context.Context, key string) (io.ReadCloser, error) {
	m.mu.RLock()
	buf, ok := m.blobs[key]
	m.mu.RUnlock()
	if !ok {
		return nil, errBlobNotFound
	}
	return io.NopCloser(bytes.NewReader(buf)), nil
}

func (m *memBlobBackend) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	delete(m.blobs, key)
	m.mu.Unlock()
	return nil
}

// ---- filesystem backend (single-node dev) ---------------------------------

type fsBlobBackend struct{ root string }

func newFSBackend(root string) (*fsBlobBackend, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("blob fs: create root: %w", err)
	}
	return &fsBlobBackend{root: root}, nil
}

// path maps a "{uid}/{sha}" key to an on-disk path, guarding against traversal.
func (b *fsBlobBackend) path(key string) string {
	return filepath.Join(b.root, filepath.FromSlash(filepath.Clean("/"+key)))
}

func (b *fsBlobBackend) Put(_ context.Context, key string, r io.Reader, _ int64) error {
	p := b.path(key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".blob-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := io.Copy(tmp, r); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, p)
}

func (b *fsBlobBackend) Get(_ context.Context, key string) (io.ReadCloser, error) {
	f, err := os.Open(b.path(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errBlobNotFound
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (b *fsBlobBackend) Delete(_ context.Context, key string) error {
	err := os.Remove(b.path(key))
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// ---- S3-compatible backend (production) -----------------------------------

type s3BlobBackend struct {
	client *s3.Client
	bucket string
}

// newS3Backend builds a client for any S3-compatible endpoint from the environment
// (PLAN §6.9). BLOB_S3_ENDPOINT + BLOB_S3_USE_PATH_STYLE target non-AWS providers (MinIO,
// B2, R2); AWS itself needs only the region. Static credentials avoid the default provider
// chain so construction never reaches out to instance metadata.
func newS3Backend() (*s3BlobBackend, error) {
	bucket := os.Getenv("BLOB_S3_BUCKET")
	access := os.Getenv("BLOB_S3_ACCESS_KEY")
	secret := os.Getenv("BLOB_S3_SECRET_KEY")
	if access == "" || secret == "" {
		return nil, errors.New("blob s3: BLOB_S3_ACCESS_KEY and BLOB_S3_SECRET_KEY are required")
	}
	region := os.Getenv("BLOB_S3_REGION")
	if region == "" {
		region = "us-east-1"
	}
	cfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(access, secret, ""),
	}
	pathStyle := os.Getenv("BLOB_S3_USE_PATH_STYLE") == "true"
	endpoint := os.Getenv("BLOB_S3_ENDPOINT")
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
		o.UsePathStyle = pathStyle
	})
	return &s3BlobBackend{client: client, bucket: bucket}, nil
}

func (b *s3BlobBackend) Put(ctx context.Context, key string, r io.Reader, size int64) error {
	_, err := b.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(b.bucket),
		Key:           aws.String(key),
		Body:          r,
		ContentLength: aws.Int64(size),
	})
	return err
}

func (b *s3BlobBackend) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := b.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(b.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		if isS3NotFound(err) {
			return nil, errBlobNotFound
		}
		return nil, err
	}
	return out.Body, nil
}

func (b *s3BlobBackend) Delete(ctx context.Context, key string) error {
	_, err := b.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(b.bucket),
		Key:    aws.String(key),
	})
	return err
}

// isS3NotFound reports whether an S3 error means the object is absent, across the codes
// different providers return ("NoSuchKey", "NotFound").
func isS3NotFound(err error) bool {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NoSuchKey", "NotFound":
			return true
		}
	}
	return false
}
