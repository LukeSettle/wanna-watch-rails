module UserEntitlements
  extend ActiveSupport::Concern

  FLAIR_STYLES = %w[popcorn film star].freeze
  PLUS_SUB_STATUSES = %w[active trialing past_due].freeze

  def entitlements_hash
    (entitlements || {}).stringify_keys
  end

  def has_entitlement?(key)
    return true if key.to_s == "ad_free" && (ad_free? || plus?)
    return true if key.to_s == "plus" && plus?

    ActiveModel::Type::Boolean.new.cast(entitlements_hash[key.to_s])
  end

  def plus?
    status = subscription_status.to_s
    return true if PLUS_SUB_STATUSES.include?(status)
    return false if stripe_subscription_id.present? && status.present?

    ActiveModel::Type::Boolean.new.cast(entitlements_hash["plus"])
  end

  def subscription_active?
    PLUS_SUB_STATUSES.include?(subscription_status.to_s)
  end

  def can_manage_subscription?
    stripe_customer_id.present? && stripe_subscription_id.present?
  end

  def grant_product!(product, stripe_session_id: nil, stripe_payment_intent: nil)
    product = ShopCatalog.find(product) unless product.respond_to?(:entitlement_keys)
    raise ArgumentError, "Unknown product" unless product

    Purchase.transaction do
      if stripe_session_id.present?
        existing = Purchase.find_by(stripe_session_id: stripe_session_id)
        return existing if existing
      end

      purchase = purchases.create!(
        product_id: product.id,
        stripe_session_id: stripe_session_id,
        stripe_payment_intent: stripe_payment_intent,
        amount_cents: product.amount_cents,
        currency: "usd",
        status: "completed"
      )

      apply_entitlements!(product.entitlement_keys)
      if product.kind == "tip"
        tips = entitlements_hash["tips"].to_i + 1
        update_entitlement!("tips", tips)
      end
      purchase
    end
  end

  def apply_entitlements!(keys)
    keys = Array(keys).map(&:to_s)
    return if keys.empty?

    attrs = {}
    merged = entitlements_hash.dup

    keys.each do |key|
      case key
      when "ad_free"
        attrs[:ad_free] = true
        merged["ad_free"] = true
      when "plus"
        attrs[:ad_free] = true
        merged["plus"] = true
        merged["ad_free"] = true
      when "supporter"
        attrs[:ad_free] = true
        merged["supporter"] = true
        merged["ad_free"] = true
      when "lobby_flair"
        merged["lobby_flair"] = true
        merged["flair_style"] ||= FLAIR_STYLES.sample
      else
        merged[key] = true
      end
    end

    attrs[:entitlements] = merged
    update!(attrs)
  end

  def update_entitlement!(key, value)
    merged = entitlements_hash.merge(key.to_s => value)
    update!(entitlements: merged)
  end

  def shop_json
    {
      "ad_free" => ad_free? || plus?,
      "plus" => plus?,
      "subscription_status" => subscription_status,
      "can_manage_subscription" => can_manage_subscription?,
      "entitlements" => entitlements_hash,
      "supporter" => has_entitlement?("supporter"),
      "flair_style" => entitlements_hash["flair_style"]
    }
  end
end
