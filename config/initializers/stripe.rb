# frozen_string_literal: true

# Stripe is configured per-request via Stripe::StripeClient in StripeCheckout.
# Keys live in ENV["STRIPE_SECRET_KEY"] / ENV["STRIPE_WEBHOOK_SECRET"] — never in source.
