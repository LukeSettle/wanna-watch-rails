# A user's lasting opinion of one title, built up across every game they play.
# Swipes record a like / nope; "already watched" records a stronger rating
# that later swipes never overwrite.
class MovieRating < ApplicationRecord
  belongs_to :user

  validates :media_key, presence: true, uniqueness: { scope: :user_id }

  scope :liked, -> { where(liked: true) }

  def self.record_swipe(user, key, liked:, genre_ids: [])
    rating = find_or_initialize_by(user: user, media_key: key)
    return rating if rating.watched?

    rating.update!(liked: liked, genre_ids: genre_ids.presence || rating.genre_ids)
    rating
  end

  def self.record_watched(user, key, liked:, genre_ids: [])
    rating = find_or_initialize_by(user: user, media_key: key)
    rating.update!(liked: liked, watched: true, genre_ids: genre_ids.presence || rating.genre_ids)
    rating
  end

  def as_json(options = {})
    super({ only: [:media_key, :liked, :watched, :updated_at] }.merge(options))
  end
end
