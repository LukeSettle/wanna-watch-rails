Rails.application.routes.draw do
  post 'users/upsert'
  get 'users/find_by_device_id'

  post 'games/upsert'
  get 'games/find_by_entry_code'
end
