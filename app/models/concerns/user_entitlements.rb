module UserEntitlements
  extend ActiveSupport::Concern

  FLAIR_STYLES = %w[popcorn film star].freeze

  def entitlements_hash
    (entitlements || {}).stringify_keys
  end

  def has_entitlement?(key)
    return true if key.to_s == "ad_free" && ad_free?

    ActiveModel::Type::Boolean.new.cast(entitlements_hash[key.to_s])
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
      "ad_free" => ad_free?,
      "entitlements" => entitlements_hash,
      "supporter" => has_entitlement?("supporter"),
      "flair_style" => entitlements_hash["flair_style"]
    }
  end
end
