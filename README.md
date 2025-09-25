# headless-render-api
Headless browser service for rendering dynamic web content. Playwright and Express, deployable with Helm.

Memory Requirements - TODO

Concurrency - Memory and CPU dependent on the host machine, but should be possible to get 10-20 concurrent requests per pod.

## Usage

```bash
curl -X POST http://localhost:3000/content -H "Content-Type: application/json" -d '{"url": "https://example.com"}'

{
  "statusCode": 200,
  "content": "<!doctype html>...</html>"
}
```

TODO: Helm deployment

## Testing Concurrency
You can use Apache Benchmark (ab) to test the concurrency of the headless-render-api. 
The following command sends 20,000 requests with a concurrency level of 200 to the `/content` or `/metrics` endpoint, posting JSON data with a URL to be rendered.
It fetches from itself, as to not overload any external sites.
```bash
echo '{"url": "http://localhost:3000/health"}' > /tmp/post_data.json && ab -n 200 -c 10 -p /tmp/post_data.json -T application/json http://localhost:3000/content
```