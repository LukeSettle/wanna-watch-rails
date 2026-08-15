class StripeWebhooksController < ActionController::API
  def create
    payload = request.body.read
    secret = ENV["STRIPE_WEBHOOK_SECRET"]

    if secret.present?
      signature = request.env["HTTP_STRIPE_SIGNATURE"]
      event = Stripe::Webhook.construct_event(payload, signature, secret)
    else
      # Local/dev without webhook signing secret — parse JSON only when explicitly allowed.
      return head :service_unavailable unless ShopCatalog.demo_unlock_allowed?

      event = Stripe::Event.construct_from(JSON.parse(payload))
    end

    handle_event(event)
    head :ok
  rescue JSON::ParserError, Stripe::SignatureVerificationError
    head :bad_request
  end

  private

  def handle_event(event)
    case event.type
    when "checkout.session.completed"
      fulfill_checkout(event.data.object)
    end
  end

  def fulfill_checkout(session)
    user_id = session.metadata&.[]("user_id") || session.client_reference_id
    product_id = session.metadata&.[]("product_id")
    user = User.find_by(id: user_id)
    product = ShopCatalog.find(product_id)
    return unless user && product

    if session.customer.present? && user.stripe_customer_id.blank?
      user.update!(stripe_customer_id: session.customer)
    end

    user.grant_product!(
      product,
      stripe_session_id: session.id,
      stripe_payment_intent: session.payment_intent
    )
  end
end
