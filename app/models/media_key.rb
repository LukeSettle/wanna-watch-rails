# Composite TMDB refs so movie and TV IDs never collide (namespaces overlap).
# Format: "movie:550" / "tv:1396". Legacy bare integers are treated as movies.
module MediaKey
  module_function

  def for(item)
    media = (item.is_a?(Hash) ? (item["media_type"] || item[:media_type]) : nil).presence || "movie"
    id = item.is_a?(Hash) ? (item["id"] || item[:id]) : item
    join(media, id)
  end

  def join(media_type, id)
    "#{normalize_media(media_type)}:#{id.to_i}"
  end

  def parse(value)
    raw = value.to_s
    if raw.include?(":")
      media, id = raw.split(":", 2)
      [normalize_media(media), id.to_i]
    else
      ["movie", raw.to_i]
    end
  end

  def normalize(value, media_type = nil)
    return nil if value.nil? || value == ""

    if media_type.present? && !value.to_s.include?(":")
      return join(media_type, value)
    end

    media, id = parse(value)
    return nil if id <= 0

    join(media, id)
  end

  def normalize_list(values, media_type = nil)
    Array(values).filter_map { |v| normalize(v, media_type) }.uniq
  end

  def normalize_media(media_type)
    media_type.to_s == "tv" ? "tv" : "movie"
  end
end
