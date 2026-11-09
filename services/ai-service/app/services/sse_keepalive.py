"""Comment lines that keep a quiet answer stream under the 60 s idle cut of nginx and load balancers in front."""
import asyncio
import contextlib
from collections.abc import AsyncIterator

KEEPALIVE_SECONDS = 25.0
# A comment line: EventSource and the console's stream readers skip it, and it never enters the answer itself.
KEEPALIVE = ": keepalive\n\n"

_END = object()


async def with_keepalive(source: AsyncIterator[str], period: float | None = None) -> AsyncIterator[str]:
    """``source``'s chunks, with ``KEEPALIVE`` after each ``period`` (default ``KEEPALIVE_SECONDS``) without one."""
    period = KEEPALIVE_SECONDS if period is None else period
    handed: asyncio.Queue = asyncio.Queue()

    # One task runs the whole answer, so its cancel scopes and timeouts stay in one task.
    async def pump():
        try:
            async for chunk in source:
                handed.put_nowait((chunk, None))
                # Go on only once the client asked for the next part, as when Starlette read the answer itself.
                await handed.join()
            handed.put_nowait((_END, None))
        except Exception as e:  # raised on the client's side
            handed.put_nowait((_END, e))
        finally:
            aclose = getattr(source, "aclose", None)
            if aclose is not None:
                await aclose()

    task = asyncio.ensure_future(pump())
    getter = None
    try:
        while True:
            if getter is None:
                getter = asyncio.ensure_future(handed.get())
            done, _ = await asyncio.wait({getter}, timeout=period)
            if not done:
                yield KEEPALIVE
                continue
            chunk, error = getter.result()
            getter = None
            if error is not None:
                raise error
            if chunk is _END:
                return
            yield chunk
            handed.task_done()
    finally:
        if getter is not None:
            getter.cancel()
        # The client went or the answer ended: cancelling runs the answer's own cancellation handling, as before.
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
