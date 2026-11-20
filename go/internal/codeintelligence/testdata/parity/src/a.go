package payment

import (
	"context"
	pb "example.com/gen/payment"
)

// Gateway charges cards.
type Gateway interface {
	Charge(ctx context.Context, amount int64) error
}

type Store struct{ db string }

type ID = string

func (s *Store) Save(ctx context.Context, p *pb.Payment, note string /* "x" */) error {
	conn.Invoke(ctx, "/payment.v1.PaymentService/Charge", p)
	return s.flush(ctx)
}

func (s Store) flush(ctx context.Context) error { return nil }

func Connect(dsn string) (*Store, error) {
	log.Printf("password=%s token=abcdefghijklmnopqrstu", dsn)
	return &Store{db: dsn}, nil
}

func Generic[T any](v T) T { return v }
