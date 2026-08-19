class StripeCheckout
  def self.configured?
    ShopCatalog.stripe_configured?
  end

  def self.client
    raise "Stripe is not configured" unless configured?

    Stripe::StripeClient.new(
      ENV.fetch("STRIPE_SECRET_KEY"),
      stripe_version: "2026-07-29.dahlia"
    )
  end

  def self.create_session!(user:, product:, success_url:, cancel_url:)
    customer_id = ensure_customer!(user)
    recurring = product.kind == "subscription" ? { interval: product.interval.presence || "month" } : nil

    params = {
      mode: product.kind == "subscription" ? "subscription" : "payment",
      customer: customer_id,
      client_reference_id: user.id.to_s,
      metadata: {
        user_id: user.id.to_s,
        product_id: product.id
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: product.amount_cents,
            product_data: {
              name: product.name,
              description: product.tagline.to_s.truncate(200),
              tax_code: product.tax_code
            }.compact
          }.tap { |price| price[:recurring] = recurring if recurring }
        }
      ],
      success_url: success_url,
      cancel_url: cancel_url
    }

    if product.kind == "subscription"
      params[:subscription_data] = {
        metadata: {
          user_id: user.id.to_s,
          product_id: product.id
        }
      }
    end

    client.v1.checkout.sessions.create(params)
  end

  def self.create_portal_session!(user:, return_url:)
    raise "Stripe is not configured" unless configured?
    raise ArgumentError, "No Stripe customer" if user.stripe_customer_id.blank?

    client.v1.billing_portal.sessions.create(
      customer: user.stripe_customer_id,
      return_url: return_url
    )
  end

  def self.retrieve_session(session_id)
    client.v1.checkout.sessions.retrieve(session_id, { expand: ["subscription"] })
  end

  def self.retrieve_subscription(subscription_id)
    client.v1.subscriptions.retrieve(subscription_id)
  end

  def self.ensure_customer!(user)
    return user.stripe_customer_id if user.stripe_customer_id.present?

    customer = client.v1.customers.create(
      email: user.email,
      name: user.username,
      metadata: { user_id: user.id.to_s }
    )
    user.update!(stripe_customer_id: customer.id)
    customer.id
  end
end
