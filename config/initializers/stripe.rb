# frozen_string_literal: true

if ENV["STRIPE_SECRET_KEY"].present?
  Stripe.api_key = ENV["STRIPE_SECRET_KEY"]
end
