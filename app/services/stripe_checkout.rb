class StripeCheckout
  def self.configured?
    ShopCatalog.stripe_configured?
  end

  def self.create_session!(user:, product:, success_url:, cancel_url:)
    raise "Stripe is not configured" unless configured?

    Stripe.api_key = ENV["STRIPE_SECRET_KEY"]

    params = {
      mode: "payment",
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
              description: product.tagline.to_s.truncate(200)
            }
          }
        }
      ],
      success_url: success_url,
      cancel_url: cancel_url
    }

    if user.stripe_customer_id.present?
      params[:customer] = user.stripe_customer_id
    elsif user.email.present?
      params[:customer_email] = user.email
    end

    session = Stripe::Checkout::Session.create(params)

    if session.customer.present? && user.stripe_customer_id.blank?
      user.update!(stripe_customer_id: session.customer)
    end

    session
  end

  def self.retrieve_session(session_id)
    Stripe.api_key = ENV["STRIPE_SECRET_KEY"]
    Stripe::Checkout::Session.retrieve(session_id)
  end
end
