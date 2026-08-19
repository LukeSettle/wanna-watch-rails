class ShopController < ApiController
  include ActionController::Cookies

  SESSION_COOKIE = :ww_session

  def catalog
    render json: {
      products: ShopCatalog.all.as_json,
      stripe_configured: ShopCatalog.stripe_configured?,
      copy: {
        headline: "WannaWatch+",
        subhead: "$2.99/month: no ads, Fine-tune on custom games, and your full likes & matches history.",
        legal: "Subscriptions are optional. Core matching never requires payment. Cancel anytime from Manage subscription."
      },
      swipe_ad_interval: ShopCatalog.swipe_ad_interval,
      entitlements: current_shop_user&.shop_json
    }
  end

  def checkout
    user = resolve_user!
    return unless user

    unless user.email.present?
      return render json: {
        error: "Create a free login first so we can restore your purchases on any device.",
        needs_account: true
      }, status: :unprocessable_entity
    end

    product = ShopCatalog.find(params[:product_id])
    return render json: { error: "Unknown product." }, status: :not_found unless product

    unless ShopCatalog.stripe_configured?
      return render json: {
        error: "Payments aren't configured yet.",
        stripe_configured: false
      }, status: :service_unavailable
    end

    base = request.base_url
    if user.subscription_active?
      portal = StripeCheckout.create_portal_session!(
        user: user,
        return_url: "#{base}/?shop=portal"
      )
      return render json: { portal_url: portal.url, already_subscribed: true }
    end

    session = StripeCheckout.create_session!(
      user: user,
      product: product,
      success_url: "#{base}/?shop=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "#{base}/?shop=cancel"
    )

    render json: { checkout_url: session.url, session_id: session.id }
  rescue Stripe::StripeError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  def portal
    user = resolve_user!
    return unless user

    unless user.can_manage_subscription?
      return render json: { error: "No subscription to manage." }, status: :unprocessable_entity
    end

    unless ShopCatalog.stripe_configured?
      return render json: { error: "Payments aren't configured yet." }, status: :service_unavailable
    end

    portal = StripeCheckout.create_portal_session!(
      user: user,
      return_url: "#{request.base_url}/?shop=portal"
    )
    render json: { portal_url: portal.url }
  rescue Stripe::StripeError, ArgumentError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  def confirm
    user = resolve_user!
    return unless user

    session_id = params[:session_id].to_s
    return render json: { error: "Missing session." }, status: :unprocessable_entity if session_id.blank?

    if ShopCatalog.stripe_configured?
      session = StripeCheckout.retrieve_session(session_id)
      if session.payment_status == "paid" || session.status == "complete"
        product_id = session.metadata["product_id"]
        product = ShopCatalog.find(product_id)
        if product && session.metadata["user_id"].to_s == user.id.to_s
          user.grant_product!(
            product,
            stripe_session_id: session.id,
            stripe_payment_intent: session.payment_intent
          )
          apply_session_subscription!(user, session)
        end
      end
    end

    render json: user_shop_payload(user.reload)
  rescue Stripe::StripeError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  def entitlements
    user = resolve_user!
    return unless user

    render json: user_shop_payload(user)
  end

  private

  def apply_session_subscription!(user, session)
    subscription = session.subscription
    return if subscription.blank?

    subscription = StripeCheckout.retrieve_subscription(subscription) if subscription.is_a?(String)
    StripeBilling.apply_subscription!(user, subscription)
  end

  def current_shop_user
    user_id = cookies.signed[SESSION_COOKIE]
    User.find_by(id: user_id) if user_id
  end

  def resolve_user!
    user = current_shop_user
    user ||= User.find_by(id: params[:user_id]) if params[:user_id].present?
    return user if user

    render json: { error: "Sign in or keep playing as a guest user first." }, status: :unauthorized
    nil
  end

  def user_shop_payload(user)
    user.as_json.merge(user.shop_json).merge(
      "email" => user.email,
      "phone" => user.phone,
      "notification_preferences" => user.notification_preferences_with_defaults
    )
  end
end
