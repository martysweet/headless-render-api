# Use official Playwright image as base - includes all dependencies
FROM mcr.microsoft.com/playwright:v1.55.0-noble AS base

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy dependencies and application
COPY app.js .

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); });"

# Start the application
CMD ["node", "app.js"]