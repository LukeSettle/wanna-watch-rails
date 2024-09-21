Rails.application.routes.draw do
  post 'users/upsert'
  get 'users/find_by_device_id'
  get 'friends/index'
  get 'friends/movie_ids'

  post 'games/upsert'
  get 'games/find_by_entry_code'
  post 'games/keep_playing'
end
