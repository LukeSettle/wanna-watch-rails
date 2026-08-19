# Syncs Stripe subscription status onto a user (plus / ad-free).
module StripeBilling
  ACTIVE_STATUSES = %w[active trialing past_due].freeze

  def self.apply_subscription!(user, subscription)
    return unless user && subscription

    status = stripe_value(subscription, :status).to_s
    sub_id = stripe_value(subscription, :id)
    customer = stripe_value(subscription, :customer)
    active = ACTIVE_STATUSES.include?(status)

    merged = user.entitlements_hash.merge("plus" => active, "ad_free" => active)
    attrs = {
      stripe_subscription_id: sub_id,
      subscription_status: status.presence,
      ad_free: active,
      entitlements: merged
    }
    if customer.present? && user.stripe_customer_id.blank?
      attrs[:stripe_customer_id] = customer
    end

    user.update!(attrs)
  end

  def self.user_for_subscription(subscription)
    sub_id = stripe_value(subscription, :id)
    customer = stripe_value(subscription, :customer)
    metadata = stripe_value(subscription, :metadata)
    user_id = metadata.is_a?(Hash) ? (metadata["user_id"] || metadata[:user_id]) : metadata&.[]("user_id")

    User.find_by(id: user_id) ||
      User.find_by(stripe_subscription_id: sub_id) ||
      User.find_by(stripe_customer_id: customer)
  end

  def self.stripe_value(object, key)
    return if object.nil?
    if object.respond_to?(:[])
      object[key.to_s] || object[key.to_sym]
    elsif object.respond_to?(key)
      object.public_send(key)
    end
  end
end
