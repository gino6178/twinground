"""Start the TwinGround web server (see server/ for the implementation)."""
from server.app import Handler, main, resources  # noqa: F401  (Handler/resources used by offline tools)

if __name__ == "__main__":
    main()
