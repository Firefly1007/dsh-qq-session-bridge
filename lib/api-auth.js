export function authenticatedHandler(ctx, handler) {
  return (req, res) => {
    let rejection;
    try {
      const connection = ctx && typeof ctx.get === 'function' ? ctx.get('connection') : null;
      if (!connection || typeof connection.requestRejection !== 'function') {
        res.statusCode = 503;
        res.end('Host authentication unavailable');
        return;
      }
      rejection = connection.requestRejection(req);
    } catch {
      res.statusCode = 503;
      res.end('Host authentication unavailable');
      return;
    }
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end(rejection === 401 ? 'Unauthorized' : 'Forbidden');
      return;
    }
    return handler(req, res);
  };
}
